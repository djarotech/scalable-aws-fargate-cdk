import ec2 = require('aws-cdk-lib/aws-ec2');
import ecs = require('aws-cdk-lib/aws-ecs');
import cdk = require('aws-cdk-lib');
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { AwsLogDriverMode, Protocol } from 'aws-cdk-lib/aws-ecs';
import { Duration, Size, StackProps } from 'aws-cdk-lib';
import { ApplicationLoadBalancer, ApplicationProtocol, DesyncMitigationMode, TargetGroupLoadBalancingAlgorithmType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { FallbackPolicy } from '@wheatstalk/fargate-spot-fallback';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ManagedPolicy, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';

export interface R7qAdvancedServerlessMicroserviceStackProps extends StackProps {
  serviceName: string;
  memoryPerServer: number;
  ecrRepo: string;
  tag: string;
  cpuPerServer: number;
  desiredCount: number;
  enableAutoscaling: boolean,
  addGatewayEndpoints: boolean,
  isX86: boolean;
  useSpot: boolean;
  internetFacing: boolean;
  vpcName?: string | undefined;
  enviromentVariables: {
      [key: string]: string;
  } | undefined;
  port: number;
  healthCheckPath: string;
  executionRoleName?: string | undefined;

}

class R7qAdvancedServerlessMicroserviceStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: R7qAdvancedServerlessMicroserviceStackProps) {
    if(!props.isX86){
      props.useSpot = false;
    }

    super(scope, id, props);
    let vpc = undefined;
    if (props.vpcName !== undefined){
      vpc = ec2.Vpc.fromLookup(this, props.vpcName, {
        isDefault: false,
      });
    }else{
      vpc = new ec2.Vpc(this, 'MyVpc', { maxAzs: 2 });
    }
    if( props.addGatewayEndpoints){
      
      vpc.addGatewayEndpoint(`${props.serviceName}-S3GatewayVpcEndpoint`, {
        service: ec2.GatewayVpcEndpointAwsService.S3
      });
      vpc.addInterfaceEndpoint(`${props.serviceName}-EcrDockerVpcEndpoint`, {
          service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER
      });
      vpc.addInterfaceEndpoint(`${props.serviceName}-EcrVpcEndpoint`, {
          service: ec2.InterfaceVpcEndpointAwsService.ECR
      });
      vpc.addInterfaceEndpoint(`${props.serviceName}-CloudWatchLogsVpcEndpoint`, {
          service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
      });

      vpc.addInterfaceEndpoint(`${props.serviceName}-CloudWatchLogsVpcEndpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT
      });
      vpc.addInterfaceEndpoint(`${props.serviceName}-XrayVpcEndpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.XRAY
      });
      
      vpc.addInterfaceEndpoint(`${props.serviceName}-XrayVpcEndpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_MONITORING
      });

    }
    let taskRole = undefined;
    if( props.executionRoleName !== undefined){
      taskRole = Role.fromRoleName(this, `${props.serviceName}-executionRole`, props.executionRoleName);
      taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"))
    }else{
      taskRole = new Role(this, `${props.serviceName}-executionRole`,{
        assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com")
      });
      taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"))
      const permissions = new PolicyStatement({
        actions: [
          'ssmmessages:*',
          'dynamodb:*',
          'rds:*',
          'cloudwatch:*',
        ],
        resources: [
          `*`
        ],
      });
      let policy = new Policy(this, `${props.serviceName}-ExecutionRolePolicy`, {
        statements: [
          permissions
        ]
      });
      taskRole.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess"))
      taskRole.attachInlinePolicy(policy);
    }
    
    const cluster = new ecs.Cluster(this, `${props.serviceName}-FargateCluster`, { 
      vpc,
      clusterName: `${props.serviceName}-FargateCluster`,
      enableFargateCapacityProviders: true,
      containerInsights: true
    });
    const logGroupApplication = new LogGroup(this, `${props.serviceName}-application-logs`, {
      retention: RetentionDays.SIX_MONTHS,
    });

    const logGroupXray = new LogGroup(this, `${props.serviceName}-x-ray-logs`, {
      retention: RetentionDays.SIX_MONTHS,
    });
    // create a task definition with CloudWatch Logs
    const logging = new ecs.AwsLogDriver({
      streamPrefix: `${props.serviceName}`,
      logGroup: logGroupApplication,
      maxBufferSize: Size.mebibytes(3),
      mode: AwsLogDriverMode.NON_BLOCKING
    });

    const xrayLogging = new ecs.AwsLogDriver({
      streamPrefix: `${props.serviceName}`,
      logGroup: logGroupXray,
      maxBufferSize: Size.mebibytes(3),
      mode: AwsLogDriverMode.NON_BLOCKING
    });


    const taskDef = new ecs.FargateTaskDefinition(this, `${props.serviceName}-TaskDefinition`, {
      memoryLimitMiB: props.memoryPerServer,
      cpu: props.cpuPerServer,
      executionRole: taskRole,
      taskRole: taskRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: props.isX86? ecs.CpuArchitecture.X86_64: ecs.CpuArchitecture.ARM64
      }
    })
    
    taskDef.addContainer('xray', {
      image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
      portMappings : [
        {
            "containerPort": 2000,
            "protocol": Protocol.UDP
        }
     ],
     cpu: 32,
     memoryReservationMiB: 128,
     essential: false,
     logging: xrayLogging
    });

    // let healthCheckUrl = `http://localhost:${props.port}${props.healthCheckPath}`;
    let healthCheckUrl = `http://localhost/`

    taskDef.addContainer(`${props.serviceName}-application`, {
      image: ecs.ContainerImage.fromEcrRepository(
        Repository.fromRepositoryArn(this, `${props.serviceName}-repository`, 
      props.ecrRepo), props.tag
      ),
      containerName: `${props.serviceName}-application`,   
      logging: logging,
      essential: true,
      environment: {
        ...props.enviromentVariables
      },
      portMappings : [
        {
            "containerPort": props.port,
            "protocol": Protocol.TCP
        }
     ],
     healthCheck: {
      command: [ "CMD-SHELL",`curl -f ${healthCheckUrl} || exit 1`],
      timeout: Duration.seconds(3),
      interval: Duration.seconds(15),
      retries: 1
     }
    });
    
    const lb = new ApplicationLoadBalancer(this, `${props.serviceName}-Alb`, {
      vpc,
      loadBalancerName: `${props.serviceName}`,
      internetFacing: props.internetFacing,
      dropInvalidHeaderFields: true,
      desyncMitigationMode: DesyncMitigationMode.STRICTEST
    });
    lb.setAttribute('routing.http.preserve_host_header.enabled', 'true');
    lb.setAttribute('target_group_health.unhealthy_state_routing.minimum_healthy_targets.percentage', `15`);
    lb.setAttribute('deregistration_delay.timeout_seconds', `60`);
    
    let listener = lb.addListener(`${props.serviceName}-listener`, {
      protocol: ApplicationProtocol.HTTP,
      port: 80
    });
    let security = new ec2.SecurityGroup(this, `${props.serviceName}-security-group`, {
      description: `Security group that defines port ingress/egress for the ${props.serviceName} backend`,
      vpc: vpc,
      allowAllOutbound: true,
      allowAllIpv6Outbound: true
    });
    security.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(props.port));

    let securityGroups = [security];

    // Create a fallback service with on-demand Fargate and a desired count of
    // zero. This service should be the same as your primary service, except
    // with a different capacity provider and an initial desired count of zero.
    let fargateService = new ecs.FargateService(this, `${props.serviceName}-FargateService`, {
      cluster,
      taskDefinition:taskDef,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1 }],
    });

    if(props.enableAutoscaling){
      const scalableTarget = fargateService.autoScaleTaskCount({
        minCapacity: Math.ceil(props.desiredCount / 2),
        maxCapacity: props.desiredCount * 2,
      });
      
      scalableTarget.scaleOnCpuUtilization(`${props.serviceName}-CpuScaling`, {
        targetUtilizationPercent: 75,
        scaleOutCooldown: Duration.minutes(2),
        scaleInCooldown: Duration.minutes(2),
      });
  
      scalableTarget.scaleOnMemoryUtilization(`${props.serviceName}-MemoryScaling`, {
        targetUtilizationPercent: 75,
        scaleOutCooldown: Duration.minutes(2),
        scaleInCooldown: Duration.minutes(2),
      });
    }

    if(props.useSpot && props.isX86){
      let fgSpotService = new ecs.FargateService(this, `${props.serviceName}-FargateSpotService`, {
        cluster,
        taskDefinition:taskDef,
        securityGroups: securityGroups,
        platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
        capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
        desiredCount: props.desiredCount,
      });
      listener.addTargets(`${props.serviceName}-FargateTarget`, {
        port: props.port,
        targets: [fgSpotService.loadBalancerTarget({
          containerName: `${props.serviceName}-application`,
          containerPort: props.port,
        }), fargateService!.loadBalancerTarget({
          containerName: `${props.serviceName}-application`,
          containerPort: props.port,
        })],
        deregistrationDelay: Duration.minutes(1),
        healthCheck: {
            interval: Duration.seconds(15),
            healthyThresholdCount: 3,
            unhealthyThresholdCount: 3,
            healthyHttpCodes: "200-299"
        },
        loadBalancingAlgorithmType: TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS
      });
      // Create the fallback policy which increases the fallback service's desired
      // count when the primary service can't provision tasks.
      new FallbackPolicy(this, `${props.serviceName}-FallbackPolicy-Do-not-delete`, {
        primaryService:fargateService,
        fallbackService: fgSpotService,
      });
    }else{
      listener.addTargets(`${props.serviceName}-FargateTarget`, {
        port: props.port,
        targets: [fargateService.loadBalancerTarget({
          containerName: `${props.serviceName}-application`,
          containerPort: props.port,
        })]
      });
    }
    
  }
}

const app = new cdk.App();
let serviceName = "r7q";
new R7qAdvancedServerlessMicroserviceStack(app, `R7qAdvancedServerlessMicroserviceStack-${serviceName}`, {
  serviceName: serviceName,
  ecrRepo: "arn:aws:ecr:us-east-1:...",
  tag: "latest",
  memoryPerServer: 2048,
  cpuPerServer: 512,
  desiredCount: 1,
  enableAutoscaling: true,
  isX86: false,
  addGatewayEndpoints: true,
  internetFacing: true,
  useSpot: false,
  healthCheckPath: "/",
  enviromentVariables: {
    "DATABASE_NAME" : `dynamodbtimeseries`,
  },
  port: 80
});

app.synth();
