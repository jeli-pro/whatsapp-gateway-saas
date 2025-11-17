# --- Build Stage ---
FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go.mod and go.sum files
COPY go.mod ./
# If you have a go.sum, copy it too
# COPY go.sum ./

# Download dependencies
# This is a separate step to leverage Docker cache
RUN go mod download

# Copy the source code
COPY . .

# Build the Go app
# -ldflags="-w -s" strips debug information and symbols to reduce binary size
# CGO_ENABLED=0 is important for a static binary for scratch image
RUN CGO_ENABLED=0 go build -ldflags="-w -s" -o /whatsapp-provider .

# --- Final Stage ---
FROM alpine:latest

# Create a directory for session data
RUN mkdir /session && chown 1000:1000 /session

# Create a non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Copy binary from builder
COPY --from=builder /whatsapp-provider /whatsapp-provider

# Expose the internal API port
EXPOSE 8080

# Define a volume for session data
VOLUME /session

# Command to run the application
CMD ["/whatsapp-provider"]