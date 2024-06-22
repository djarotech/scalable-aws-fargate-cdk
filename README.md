# A highly scalable, duplicable ECS Fargate infrastructure (just provide docker container)


With this setup, you can easily scale to thousands of TPS. It features AWS Xray side car (for request tracing), logging, autoscaling rules, optimized load balancer, health check on load balancer, and more.

It features an option to use exclusively spot instances to run the server at a low cost. If there is no capacity, there is a lambda that will switchover to normal instances.

## Instructions
To deploy it, first push your docker image to an ecr, then provide this info in the props. Next, run `npm install && npm deploy`, to deploy it to cloudformation.

Follow my [AWS Blog](https://www.synchronizationofus.com/) 