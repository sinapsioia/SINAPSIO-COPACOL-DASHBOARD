FROM python:3.12-slim

WORKDIR /app
COPY . .

ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8787/api/config')"

CMD ["python", "-u", "app.py"]
