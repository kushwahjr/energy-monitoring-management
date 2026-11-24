# For the cloud server (mode "cloud"). Mount your config and a data folder:
#   docker build -t energy-logger .
#   docker run -d -p 8080:8080 -v $PWD/cloud.json:/app/config.json -v $PWD/data:/app/data energy-logger
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["python", "run.py", "--config", "/app/config.json"]
