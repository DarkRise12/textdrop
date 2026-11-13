FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY server.py backup.py preview.py ./
COPY static ./static
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8765
CMD ["python", "server.py"]
