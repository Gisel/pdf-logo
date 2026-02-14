FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src

# Copy samples folder for logo refs and banners
COPY --from=root /samples ./samples

# Expose port
EXPOSE 3001

# Start the app
CMD ["node", "src/index.js"]
