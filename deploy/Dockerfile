FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts
COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["npm", "run", "server"]
