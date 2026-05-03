FROM python:3.12-slim

WORKDIR /app
COPY . .

ENV PORT=8788
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\", \"8788\")}/api/config')"

CMD ["python", "-u", "app.py"]
