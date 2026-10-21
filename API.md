# API Documentation

## Overview
This NestJS backend provides RESTful APIs for an e-commerce platform with the following modules:

## Modules

### Auth Module
- **Endpoints**: POST /auth/register, POST /auth/login, POST /auth/logout
- **Description**: User authentication and authorization
- **Guards**: AuthGuard for protected routes

### Products Module
- **Endpoints**: GET /products, GET /products/:id, POST /products, PUT /products/:id, DELETE /products/:id
- **Description**: Product catalog management
- **Filters**: Category-based filtering

### Categories Module
- **Endpoints**: GET /categories, POST /categories, PUT /categories/:id, DELETE /categories/:id
- **Description**: Product category management

### Cart Module
- **Endpoints**: GET /cart, POST /cart/add, DELETE /cart/remove/:id
- **Description**: Shopping cart operations

### Orders Module
- **Endpoints**: GET /orders, POST /orders, GET /orders/:id
- **Description**: Order management and tracking

### Reviews Module
- **Endpoints**: GET /reviews/:productId, POST /reviews, DELETE /reviews/:id
- **Description**: Product reviews and ratings

### Wishlist Module
- **Endpoints**: GET /wishlist, POST /wishlist/add, DELETE /wishlist/remove/:id
- **Description**: User wishlist management

## Authentication
All endpoints requiring authentication use the AuthGuard and CurrentUser decorator.
JWT tokens are required in the Authorization header: `Bearer {token}`

## Error Handling
Global exception filter handles:
- HttpException errors
- Validation errors via ZodValidationPipe
- Database errors with appropriate HTTP status codes

## Database
- PostgreSQL via Supabase
- Schema defined by the timestamped migrations in supabase/migrations (supabase-schema.sql is a legacy snapshot)
