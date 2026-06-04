FROM node:20-slim

WORKDIR /app

# Suppress debconf dialogs and install build tools + git
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifest and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure session directories exist and are writable
RUN mkdir -p /app/qr_sessions /app/session

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app
USER appuser

# Koyeb injects PORT at runtime; default to 8000
EXPOSE 8000
ENV PORT=8000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8000)+'/', (r)=>r.statusCode===200?process.exit(0):process.exit(1))"

CMD ["node", "index.js"]
