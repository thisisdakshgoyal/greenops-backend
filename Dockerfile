FROM node:20-alpine

# Workdir inside the container
WORKDIR /app

# Copy only package files first (for better layer caching)
COPY package*.json ./

# Install only production deps, with retry-friendly npm config
RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 10000 \
  && npm config set fetch-retry-maxtimeout 60000 \
  && npm ci --omit=dev

# Now copy the actual source
COPY src ./src

# Environment
ENV PORT=4000

EXPOSE 4000

CMD ["node", "src/server.js"]