#!/bin/sh
# GL.iNet Router - Fix for LAN-to-LAN communication and VDO.Ninja feeds
# This allows devices on the LAN to communicate with each other directly

echo "=== Adding LAN-to-LAN iptables rule ==="
# Insert rule at the beginning of FORWARD chain to allow br-lan to br-lan traffic
iptables -I FORWARD 1 -i br-lan -o br-lan -j ACCEPT

echo ""
echo "=== Verifying rule was added ==="
iptables -L FORWARD -v -n | grep -A 1 "br-lan.*br-lan"

echo ""
echo "=== Current FORWARD chain (first 10 rules) ==="
iptables -L FORWARD -v -n --line-numbers | head -15

echo ""
echo "=== Making rule permanent in /etc/firewall.user ==="

# Backup current firewall.user
cp /etc/firewall.user /etc/firewall.user.backup-$(date +%Y%m%d-%H%M%S)

# Update firewall.user to include LAN-to-LAN rule
cat > /etc/firewall.user << 'EOF'
#!/bin/sh

# GL.iNet Blackhole Fix - Runs on every firewall restart
sleep 2

# Remove any blackhole rules
ip rule del from all iif br-lan blackhole 2>/dev/null
ip rule del pref 9920 2>/dev/null
ip rule del pref 9910 2>/dev/null
ip route flush table 9910 2>/dev/null

# Allow LAN-to-LAN traffic (critical for local device communication)
iptables -I FORWARD 1 -i br-lan -o br-lan -j ACCEPT

exit 0
EOF

chmod +x /etc/firewall.user

echo ""
echo "=== Updated /etc/firewall.user ==="
cat /etc/firewall.user

echo ""
echo "=== Testing local connectivity ==="
echo "Attempting to ping Pi from router..."
ping -c 2 192.168.8.200

echo ""
echo "=== Fix applied successfully ==="
echo ""
echo "Next steps:"
echo "1. From Mac Mini, try: curl -I http://192.168.8.200:8080"
echo "2. From Mac Mini, open browser to: http://192.168.8.200:8080/slot/1"
echo "3. Check if VDO.Ninja feed is now visible"
echo "4. If working, verify persistence with: reboot"
