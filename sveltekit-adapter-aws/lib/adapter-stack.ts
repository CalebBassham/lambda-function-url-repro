import {Construct} from 'constructs';
import {
    StackProps,
    Stack,
    Fn,
    RemovalPolicy,
    Duration,
    CfnOutput,
    aws_lambda,
    aws_s3,
    aws_s3_deployment,
    aws_cloudfront_origins,
    aws_certificatemanager,
    aws_route53,
    aws_route53_targets,
    aws_cloudfront,
} from 'aws-cdk-lib';
import {config} from 'dotenv';
import {FunctionUrlAuthType, HttpMethod} from "aws-cdk-lib/aws-lambda";

export interface AWSAdapterStackProps extends StackProps {
    FQDN: string;
    account?: string;
    region?: string;
}

export class AWSAdapterStack extends Stack {
    bucket: aws_s3.IBucket;
    serverHandler: aws_lambda.IFunction;
    hostedZone: aws_route53.IHostedZone;
    certificate: aws_certificatemanager.ICertificate;

    constructor(scope: Construct, id: string, props: AWSAdapterStackProps) {
        super(scope, id, props);

        const routes = process.env.ROUTES?.split(',') || [];
        const projectPath = process.env.PROJECT_PATH;
        const serverPath = process.env.SERVER_PATH;
        const staticPath = process.env.STATIC_PATH;
        const prerenderedPath = process.env.PRERENDERED_PATH;
        const logRetention = parseInt(process.env.LOG_RETENTION_DAYS!) || 7;
        const memorySize = parseInt(process.env.MEMORY_SIZE!) || 128;
        const environment = config({path: projectPath});
        const [_, zoneName, TLD] = process.env.FQDN?.split('.') || [];
        const domainName = `${zoneName}.${TLD}`;

        this.serverHandler = new aws_lambda.Function(this, 'LambdaServerFunctionHandler', {
            code: new aws_lambda.AssetCode(serverPath!),
            handler: 'index.handler',
            runtime: aws_lambda.Runtime.NODEJS_16_X,
            timeout: Duration.minutes(15),
            memorySize,
            logRetention,
            environment: {
                ...environment.parsed,
            } as any,
        });

        const functionUrl = this.serverHandler.addFunctionUrl({
            authType: FunctionUrlAuthType.NONE,
            cors: {
                allowedHeaders: ['*'],
                allowedMethods: [HttpMethod.ALL],
                allowedOrigins: ['*']
            }
        })

        console.log("functionUrl:", functionUrl.url)


        this.bucket = new aws_s3.Bucket(this, 'StaticContentBucket', {
            removalPolicy: RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        if (process.env.FQDN) {
            this.hostedZone = aws_route53.HostedZone.fromLookup(this, 'HostedZone', {
                domainName,
            }) as aws_route53.HostedZone;

            this.certificate = new aws_certificatemanager.DnsValidatedCertificate(this, 'DnsValidatedCertificate', {
                domainName: process.env.FQDN!,
                hostedZone: this.hostedZone,
                region: 'us-east-1',
            });
        }

        const distribution = new aws_cloudfront.Distribution(this, 'CloudFrontDistribution', {
            priceClass: aws_cloudfront.PriceClass.PRICE_CLASS_100,
            enabled: true,
            defaultRootObject: '',
            sslSupportMethod: aws_cloudfront.SSLMethod.SNI,
            domainNames: process.env.FQDN ? [process.env.FQDN!] : [],
            certificate: process.env.FQDN
                ? aws_certificatemanager.Certificate.fromCertificateArn(
                    this,
                    'DomainCertificate',
                    this.certificate.certificateArn
                )
                : undefined,
            defaultBehavior: {
                compress: true,
                origin: new aws_cloudfront_origins.HttpOrigin(Fn.select(2, Fn.split('/', functionUrl.url)), {
                    protocolPolicy: aws_cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                }),
                viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: aws_cloudfront.AllowedMethods.ALLOW_ALL,
                originRequestPolicy: new aws_cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
                    cookieBehavior: aws_cloudfront.OriginRequestCookieBehavior.all(),
                    queryStringBehavior: aws_cloudfront.OriginRequestQueryStringBehavior.all(),
                    headerBehavior: aws_cloudfront.OriginRequestHeaderBehavior.allowList(
                        'Origin',
                        'Accept-Charset',
                        'Accept',
                        'Access-Control-Request-Method',
                        'Access-Control-Request-Headers',
                        'Referer',
                        'Accept-Language',
                        'Accept-Datetime'
                    ),
                }),
                cachePolicy: aws_cloudfront.CachePolicy.CACHING_DISABLED,
            },
        });

        const s3Origin = new aws_cloudfront_origins.S3Origin(this.bucket, {});
        routes.forEach((route) => {
            distribution.addBehavior(route, s3Origin, {
                viewerProtocolPolicy: aws_cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: aws_cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                originRequestPolicy: aws_cloudfront.OriginRequestPolicy.USER_AGENT_REFERER_HEADERS,
                cachePolicy: aws_cloudfront.CachePolicy.CACHING_OPTIMIZED,
            });
        });

        if (process.env.FQDN) {
            new aws_route53.ARecord(this, 'ARecord', {
                recordName: process.env.FQDN,
                target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.CloudFrontTarget(distribution)),
                zone: this.hostedZone,
            });
        }

        new aws_s3_deployment.BucketDeployment(this, 'StaticContentDeployment', {
            destinationBucket: this.bucket,
            sources: [aws_s3_deployment.Source.asset(staticPath!), aws_s3_deployment.Source.asset(prerenderedPath!)],
            retainOnDelete: false,
            prune: true,
            distribution,
            distributionPaths: ['/*'],
        });

        new CfnOutput(this, 'appUrl', {
            value: process.env.FQDN ? `https://${process.env.FQDN}` : `https://${distribution.domainName}`,
        });

        new CfnOutput(this, 'stackName', {value: id});
    }
}
