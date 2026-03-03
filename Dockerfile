FROM node:20-slim

# better-sqlite3 requires build tools to compile native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# uploads/ is a temp dir for CSV imports; /data is the volume mount point for SQLite
RUN mkdir -p uploads

EXPOSE 3000

CMD ["node", "app.js"]
