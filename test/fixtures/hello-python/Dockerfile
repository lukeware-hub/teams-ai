FROM python:3.11-slim-bookworm AS build
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --target /deps itsdangerous==2.2.0

FROM python:3.11-slim-bookworm
RUN useradd --system --uid 10001 app
WORKDIR /app
COPY --from=build /deps /deps
COPY app.py .
ENV PYTHONPATH=/deps PORT=8080
USER app
EXPOSE 8080
CMD ["python", "app.py"]
