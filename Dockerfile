FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
LABEL org.opencontainers.image.title="Textdrop" \
      org.opencontainers.image.description="Private text and file sharing between your devices" \
      org.opencontainers.image.source="https://github.com/DarkRise12/textdrop" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY requirements.txt LICENSE ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY server.py accounts.py backup.py preview.py ./
COPY static ./static
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8765
CMD ["python", "server.py"]
