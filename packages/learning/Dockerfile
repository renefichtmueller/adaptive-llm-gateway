FROM node:22-alpine

WORKDIR /app

# Install tsx for running TypeScript directly
RUN npm install -g tsx

# Copy workspace root and learning package manifests
COPY package.json ./
COPY packages/learning/package.json ./packages/learning/

# Install dependencies
RUN npm install --workspace=packages/learning

# Copy learning source
COPY packages/learning/src ./packages/learning/src

CMD ["node", "--import", "tsx/esm", "packages/learning/src/index.ts"]
