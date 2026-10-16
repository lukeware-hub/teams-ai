FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /web/out ./cmd/server/static
RUN CGO_ENABLED=0 go build -o /out/license ./cmd/server

FROM alpine:3.21
RUN apk add --no-cache ca-certificates
COPY --from=build /out/license /usr/local/bin/license
USER 65534
EXPOSE 8080
ENTRYPOINT ["license"]
