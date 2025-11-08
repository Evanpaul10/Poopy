#!/bin/bash

# Merimac Bridge Update Script
# Updates the service from the GitHub repository

set -e  # Exit on error

BRANCH="claude/fix-group-page-loading-011CUv3ueRc1SPPiY4ez3Khf"
SERVICE_DIR="/opt/merimac-bridge"
SERVICE_NAME="merimac-bridge"
OWNER="ef:ef"

echo "=========================================="
echo "Merimac Bridge Update Script"
echo "=========================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: Please run with sudo"
    exit 1
fi

# Stop the service
echo "→ Stopping service..."
systemctl stop $SERVICE_NAME
echo "✓ Service stopped"
echo ""

# Navigate to service directory
if [ ! -d "$SERVICE_DIR" ]; then
    echo "Error: Service directory $SERVICE_DIR not found"
    exit 1
fi

cd $SERVICE_DIR
echo "→ Working directory: $(pwd)"
echo ""

# Fetch latest changes
echo "→ Fetching latest changes from branch: $BRANCH"
git fetch origin $BRANCH
echo "✓ Fetch complete"
echo ""

# Reset to latest
echo "→ Updating to latest version..."
git reset --hard origin/$BRANCH
echo "✓ Update complete"
echo ""

# Show current commit
CURRENT_COMMIT=$(git log -1 --oneline)
echo "→ Current version: $CURRENT_COMMIT"
echo ""

# Fix ownership
echo "→ Fixing file permissions..."
chown -R $OWNER $SERVICE_DIR
echo "✓ Permissions fixed"
echo ""

# Start the service
echo "→ Starting service..."
systemctl start $SERVICE_NAME
echo "✓ Service started"
echo ""

# Check status
sleep 2
if systemctl is-active --quiet $SERVICE_NAME; then
    echo "=========================================="
    echo "✅ Update successful!"
    echo "=========================================="
    systemctl status $SERVICE_NAME --no-pager -l
else
    echo "=========================================="
    echo "⚠️  Warning: Service may not have started correctly"
    echo "=========================================="
    systemctl status $SERVICE_NAME --no-pager -l
    exit 1
fi
