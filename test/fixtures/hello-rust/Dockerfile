FROM rust:1.99-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-20261005-slim
COPY --from=build /src/target/release/hello /usr/local/bin/hello
USER 10001:10001
ENV PORT=8080
EXPOSE 8080
CMD ["hello"]
