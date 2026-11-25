# Python 服务共用镜像：chroma_server / chat_relay / ai_brain。
# 具体启动命令由 docker-compose.yml 的 command 覆盖。
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY chat_relay ./chat_relay
COPY ai_brain ./ai_brain
COPY memory_service/chroma_server.py ./memory_service/chroma_server.py
COPY web ./web

ENV PYTHONUNBUFFERED=1
ENV PYTHONIOENCODING=utf-8
ENV TIDAL_BIND=0.0.0.0

CMD ["python", "-u", "chat_relay/app.py"]
