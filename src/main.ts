import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/http-exception.filter.js';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
    process.exit(1);
  }

  const corsOriginValue =
    process.env.CORS_ORIGIN || 'https://dhakawholesale.com';
  const isDev = process.env.NODE_ENV !== 'production';

  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  const corsOrigins = corsOriginValue
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (isDev && !corsOrigins.includes('http://localhost:3000')) {
    corsOrigins.push('http://localhost:3000');
  }

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression());
  // Parses the httpOnly session cookie (`dw_session`) so guards and
  // controllers can authenticate requests that carry no Authorization header.
  app.use(cookieParser());

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  if (process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Dhaka Wholesale E-Commerce API')
      .setDescription('E-commerce backend for Dhaka Wholesale store')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();

  const port = process.env.PORT ?? 5000;
  await app.listen(port);
  logger.log(`Application is running on: http://localhost:${port}`);
  if (process.env.ENABLE_SWAGGER === 'true') {
    logger.log(`Swagger docs: http://localhost:${port}/api/docs`);
  }
}
void bootstrap();
