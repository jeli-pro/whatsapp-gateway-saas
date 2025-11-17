# Multi-stage build for optimal image size and security
# Build stage - compiles the Go binary
FROM golang:1.24-alpine AS builder

# Install build dependencies for CGO (required for SQLite3)
RUN apk add --no-cache git ca-certificates tzdata gcc musl-dev

# Set working directory
WORKDIR /src

# Copy go mod file first for better layer caching
COPY go.mod ./

# Download dependencies - this layer only rebuilds when go.mod changes
RUN go mod download

# Copy source code
COPY . .

# Generate go.sum and tidy dependencies
RUN go mod tidy

# Build arguments for versioning and optimization
ARG VERSION=dev
ARG BUILD_TIME

# Build the application with optimizations
# - CGO_ENABLED=1 required for SQLite3 support
# - -ldflags strips debug symbols and sets build info
# - -trimpath removes file system paths from binary
RUN CGO_ENABLED=1 \
    GOOS=linux \
    GOARCH=amd64 \
    go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}" \
    -o /bin/whatsapp-gateway \
    .

# Final runtime stage - minimal secure image
FROM alpine:3.20

# Install runtime dependencies
RUN apk --no-cache add \
    ca-certificates \
    tzdata \
    wget \
    sqlite \
    && rm -rf /var/cache/apk/*

# Create non-root user and group for security
RUN addgroup -S -g 1001 appgroup && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G appgroup appuser

# Create directories with proper permissions
RUN mkdir -p /app/session /app/logs && \
    chown -R appuser:appgroup /app && \
    chmod 755 /app/session

# Set working directory
WORKDIR /app

# Copy binary from builder stage
COPY --from=builder /bin/whatsapp-gateway /usr/local/bin/whatsapp-gateway

# Ensure binary is executable
RUN chmod +x /usr/local/bin/whatsapp-gateway

# Switch to non-root user
USER appuser

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose application port
EXPOSE 8080

# Define persistent volumes
VOLUME ["/app/session"]

# Set environment variables
ENV PORT=8080
ENV GOMAXPROCS=1

# Container entrypoint
ENTRYPOINT ["whatsapp-gateway"]