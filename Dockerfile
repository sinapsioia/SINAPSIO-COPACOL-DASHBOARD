FROM python:3.12-slim

WORKDIR /app
COPY . .

ENV PORT=8787
EXPOSE 8787

CMD ["python", "app.py"]
