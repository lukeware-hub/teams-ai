FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /hello .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /hello /hello
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/hello"]
