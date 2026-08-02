// @ts-nocheck — this file imports from ../dist/ which only exists after nest build
// It is compiled separately by Vercel using api/tsconfig.json, not by nest build
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import express from 'express';
import * as path from 'path';

const server = express();
let app: any;

async function bootstrap() {
  if (app) return app;

  const envCheck = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']
    .filter(k => !process.env[k]);
  if (envCheck.length) {
    console.warn(`[bootstrap] Missing env vars (will fail downstream): ${envCheck.join(', ')}`);
  }

  const { AppModule } = await import(path.join(__dirname, '..', 'dist', 'src', 'app.module.js'));
  const { AllExceptionsFilter } = await import(path.join(__dirname, '..', 'dist', 'src', 'common', 'filters', 'http-exception.filter.js'));
  const { TransformInterceptor } = await import(path.join(__dirname, '..', 'dist', 'src', 'common', 'interceptors', 'transform.interceptor.js'));

  const adapter = new ExpressAdapter(server);
  app = await NestFactory.create(AppModule, adapter);

  app.setGlobalPrefix('api');

  // Fail-closed CORS: no wildcard fallback. If CORS_ORIGIN is unset,
  // only the production site is allowed — a local dev frontend must
  // explicitly opt in via CORS_ORIGIN.
  const corsOriginValue =
    process.env.CORS_ORIGIN || 'https://dhakawholesale.com';
  const corsOrigins = corsOriginValue.split(',').map((o: string) => o.trim()).filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    // A JSON API has no inline scripts/styles of its own; a restrictive
    // CSP is both safe and free here.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(compression());

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  if (process.env.ENABLE_SWAGGER === 'true') {
    const swagger = await import('@nestjs/swagger');
    const config = new swagger.DocumentBuilder()
      .setTitle('Dhaka Wholesale E-Commerce API')
      .setDescription('E-commerce backend for Dhaka Wholesale store')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = swagger.SwaggerModule.createDocument(app, config);
    swagger.SwaggerModule.setup('api/docs', app, document);
  }

  await app.init();
  return app;
}

export default async function handler(req: any, res: any) {
  try {
    await bootstrap();
    server(req, res);
  } catch (err: any) {
    console.error('[handler] Bootstrap error:', err);
    // Never echo internal error text (paths, env names, DB messages)
    // to the caller.
    res.status(500).json({
      error: 'Function invocation failed',
    });
  }
}
