# # Stage 1: build
# FROM node:20-alpine AS builder
# WORKDIR /app
# COPY package*.json ./
# RUN npm ci
# COPY tsconfig.json ./
# COPY src ./src
# COPY public ./public
# RUN npm run build

# # Stage 2: production image
# FROM node:20-alpine AS production
# WORKDIR /app
# ENV NODE_ENV=production
# COPY package*.json ./
# RUN npm ci --omit=dev && npm cache clean --force
# COPY --from=builder /app/dist ./dist
# COPY --from=builder /app/public ./public
# COPY src/data ./dist/data
# EXPOSE 3000
# CMD ["node", "dist/server.js"]


# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# Add this so the builder can see the docs if needed during build/validation
COPY docs ./docs 
RUN npm run build

# Stage 2: production image
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
# FIX: Copy the docs folder from the builder stage to the production stage
COPY --from=builder /app/docs ./docs
COPY src/data ./dist/data

EXPOSE 3000
CMD ["node", "dist/server.js"]