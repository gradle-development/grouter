docker stop grouter
docker rm grouter
docker build -t grouter .
docker run -d --name grouter -p 20128:20128 --env-file .env -v grouter-data:/app/data grouter