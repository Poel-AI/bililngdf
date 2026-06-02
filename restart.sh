#!/bin/bash


# Kill any process using port 3500
echo "Checking for processes on port 3500..."
PIDS=$(lsof -ti:3500)

if [ ! -z "$PIDS" ]; then
    echo "Found processes on port 3500: $PIDS"
    echo "Killing processes..."
    kill $PIDS
    sleep 2
    echo "Processes killed."
else
    echo "No processes found on port 3500."
fi

# Start the server
echo "Starting server..."
npm start

