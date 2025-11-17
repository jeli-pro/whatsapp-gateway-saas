# --- Build Stage ---
# Use an official Go image as the builder.
# Using alpine for a smaller builder image.
FROM golang:1.21-alpine AS builder

# Set the working directory inside the container
WORKDIR /src

# Copy go.mod and go.sum to leverage Docker's layer caching.
# This layer is only rebuilt when dependencies change.
COPY go.mod go.sum ./

# Download Go module dependencies
RUN go mod download

# Copy the rest of the source code into the container
COPY . .

# Build a statically-linked, stripped binary for a minimal final image.
# CGO_ENABLED=0 is for static linking.
# -ldflags='-s -w' strips debug symbols to reduce binary size.
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o /bin/app .

# --- Final Stage ---
# Use a minimal base image for the final container.
# alpine is a good choice for its small size.
FROM alpine:latest

# Add ca-certificates for making HTTPS calls (e.g., for webhooks).
RUN apk --no-cache add ca-certificates

# Create a non-root user and group for security.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create and set ownership for the session directory.
# This directory will be used for the VOLUME to persist session data.
RUN mkdir /session && chown appuser:appgroup /session

# Copy the compiled binary from the builder stage.
COPY --from=builder /bin/app /bin/app

# Switch to the non-root user.
USER appuser

# Expose the internal API port used by the Go application.
EXPOSE 8080

# Define a volume for session data persistence.
# This allows session data to be stored outside the container.
VOLUME /session

# Set the entrypoint to run the application.
ENTRYPOINT ["/bin/app"]