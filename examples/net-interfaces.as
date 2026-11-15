// flash.net.NetworkInfo.findInterfaces: the OS interface inventory.
//
// This is the one AIR "shell" surface a real project cannot live without. A real
// desktop client derives its device id from the first interface that reports a
// hardwareAddress; while this build answered an empty Vector on Windows, that
// fall-through reached a Windows-only path and threw inside the document class
// constructor -- before any window existed -- so the application printed one line
// and exited(1) at startup. The Windows backend (GetAdaptersAddresses) now answers
// a real inventory, so that fall-through no longer runs.
//
// Every value pinned below was measured on adl 51.4.1, and the assertions hold on
// ANY host. The inventory's FORM is platform-specific (both measured, not assumed):
//   - networkInfo is the documented singleton, and findInterfaces hands out a NEW
//     Vector with NEW NetworkInterface objects on every call;
//   - a reported interface always has at least one address; a FRESH
//     NetworkInterface reports ""/""/""/false/-1 with NULL addresses and
//     subInterfaces (not empty Vectors);
//   - IPv6 LINK-LOCAL addresses (fe80::/10) are never reported -- an interface
//     that only has those does not appear at all;
//   - hardwareAddress is AIR's exact per-platform form, and callers store it as a
//     device id, so the form is part of the contract:
//       POSIX:   "aa:bb:cc:dd:ee:ff " -- lowercase ':' pairs + ONE trailing space;
//       Windows: "AA-BB-CC-DD-EE-FF" -- uppercase '-' pairs, NO trailing space;
//   - name is the POSIX interface name ("en0") but the Windows adapter GUID;
//     displayName is "" on POSIX and the Windows FriendlyName;
//   - active is UP/RUNNING/not-loopback on POSIX, but OperStatus==up on Windows
//     (the Windows loopback pseudo-interface reports active=true);
//   - mtu is positive on POSIX (lo0 is 16384); the Windows loopback reports -1;
//   - addresses keep the platform's natural order (POSIX IPv4-first; Windows the
//     adapter's unicast order, IPv6 may precede IPv4);
//   - ipVersion is "IPv4" or "IPv6" (IPVersion's constants), prefixLength is the
//     netmask width, and broadcast is "" for anything that is not an IPv4
//     broadcast address (the loopback has none).
import flash.net.NetworkInfo;
import flash.net.NetworkInterface;
import flash.net.InterfaceAddress;
import flash.net.IPVersion;
import flash.system.Capabilities;

var isWindows: Boolean = Capabilities.os.indexOf("Win") >= 0;

function fail(what: String): void {
  throw new Error("net-interfaces: " + what);
}

function isHexDigit(ch: String, upper: Boolean): Boolean {
  if (ch >= "0" && ch <= "9") return true;
  return upper ? (ch >= "A" && ch <= "F") : (ch >= "a" && ch <= "f");
}

// AIR's hardwareAddress form is platform-specific (see the header). "" is allowed:
// an interface with no link layer (the loopback) reports an empty string.
function isAirMac(v: String): Boolean {
  if (v.length == 0) return true;
  var body: String = v;
  if (!isWindows) {
    if (v.charAt(v.length - 1) != " ") return false;   // POSIX trailing space
    body = v.substring(0, v.length - 1);
  }
  var parts: Array = body.split(isWindows ? "-" : ":");
  if (parts.length < 2) return false;
  for (var i: int = 0; i < parts.length; i++) {
    var p: String = parts[i];
    if (p.length != 2) return false;
    if (!isHexDigit(p.charAt(0), isWindows) || !isHexDigit(p.charAt(1), isWindows)) return false;
  }
  return true;
}

function isDottedQuad(v: String): Boolean {
  var parts: Array = v.split(".");
  if (parts.length != 4) return false;
  for (var i: int = 0; i < 4; i++) {
    var p: String = parts[i];
    if (p.length < 1 || p.length > 3) return false;
    for (var k: int = 0; k < p.length; k++) {
      var c: String = p.charAt(k);
      if (c < "0" || c > "9") return false;
    }
  }
  return true;
}

// ---- the singleton and its statics -----------------------------------------
if (NetworkInfo.networkInfo !== NetworkInfo.networkInfo) fail("networkInfo is not a singleton");
if (!NetworkInfo.isSupported) fail("isSupported should be true on a desktop host (" + Capabilities.os + ")");

// ---- a fresh object's defaults (measured, not assumed) ----------------------
var fresh: NetworkInterface = new NetworkInterface();
if (fresh.name != "") fail("fresh name should be \"\": [" + fresh.name + "]");
if (fresh.displayName != "") fail("fresh displayName should be \"\"");
if (fresh.hardwareAddress != "") fail("fresh hardwareAddress should be \"\"");
if (fresh.active) fail("fresh active should be false");
if (fresh.mtu != -1) fail("fresh mtu should be -1, got " + fresh.mtu);
if (fresh.parent != null) fail("fresh parent should be null");
if (fresh.addresses != null) fail("fresh addresses should be null, not an empty Vector");
if (fresh.subInterfaces != null) fail("fresh subInterfaces should be null, not an empty Vector");
var freshAddr: InterfaceAddress = new InterfaceAddress();
if (freshAddr.ipVersion != IPVersion.IPV4) fail("fresh ipVersion should be IPVersion.IPV4, got " + freshAddr.ipVersion);
if (freshAddr.address != "") fail("fresh address should be \"\"");
if (freshAddr.broadcast != "") fail("fresh broadcast should be \"\"");
if (freshAddr.prefixLength != -1) fail("fresh prefixLength should be -1, got " + freshAddr.prefixLength);

// ---- identity: a new Vector and new objects per call ----------------------
var first: Vector.<NetworkInterface> = NetworkInfo.networkInfo.findInterfaces();
var second: Vector.<NetworkInterface> = NetworkInfo.networkInfo.findInterfaces();
if (first == null) fail("findInterfaces returned null");
if (second == null) fail("second findInterfaces returned null");
if (first === second) fail("findInterfaces must hand out a NEW Vector per call");
if (first.length != second.length) fail("the inventory changed between two calls: " + first.length + " vs " + second.length);
if (first.length > 0 && first[0] === second[0]) fail("NetworkInterface objects must be fresh per call");

// Both backends are real now (POSIX getifaddrs, Windows GetAdaptersAddresses), so
// every desktop host must report a non-empty inventory.
if (first.length == 0) fail("no interfaces reported on " + Capabilities.os);

var seenNames: Array = [];
var withMac: int = 0;
for (var n: int = 0; n < first.length; n++) {
  var iface: NetworkInterface = first[n];
  if (iface.name == null || iface.name.length == 0) fail("interface[" + n + "] has no name");
  for (var s: int = 0; s < seenNames.length; s++) {
    if (seenNames[s] == iface.name) fail("interface " + iface.name + " reported twice");
  }
  seenNames.push(iface.name);
  if (iface.hardwareAddress != null && iface.hardwareAddress.length > 0) withMac++;
  if (iface.hardwareAddress == null) fail(iface.name + ": hardwareAddress should be \"\" when absent, not null");
  if (!isAirMac(iface.hardwareAddress)) fail(iface.name + ": hardwareAddress is not AIR's form: [" + iface.hardwareAddress + "]");
  if (typeof iface.active != "boolean") fail(iface.name + ": active is not a Boolean");
  if (iface.parent != null) fail(iface.name + ": parent should be null");
  if (iface.subInterfaces != null) fail(iface.name + ": subInterfaces should be null");

  var addrs: Vector.<InterfaceAddress> = iface.addresses;
  if (addrs == null) fail(iface.name + ": an enumerated interface must carry an addresses Vector");
  if (addrs.length == 0) fail(iface.name + ": reported without any address");
  if (addrs !== iface.addresses) fail(iface.name + ": addresses must be the SAME Vector on repeated reads");

  // The Windows loopback pseudo-interface reports mtu -1 (its Mtu is 0xFFFFFFFF);
  // every other enumerated interface has a positive mtu on both platforms.
  var isLoopback: Boolean = false;
  for (var z: int = 0; z < addrs.length; z++) {
    if (addrs[z].address == "127.0.0.1" || addrs[z].address == "::1") isLoopback = true;
  }
  if (iface.mtu <= 0 && !(isWindows && isLoopback && iface.mtu == -1)) {
    fail(iface.name + ": mtu should be positive on an enumerated interface, got " + iface.mtu);
  }

  for (var a: int = 0; a < addrs.length; a++) {
    var ad: InterfaceAddress = addrs[a];
    if (ad.address == null || ad.address.length == 0) fail(iface.name + ": address[" + a + "] is empty");
    var v4: Boolean = (ad.ipVersion == IPVersion.IPV4);
    if (!v4 && ad.ipVersion != IPVersion.IPV6) fail(iface.name + ": unknown ipVersion " + ad.ipVersion);
    if (v4) {
      if (!isDottedQuad(ad.address)) fail(iface.name + ": IPv4 address is not dotted-quad: " + ad.address);
      if (ad.prefixLength < 0 || ad.prefixLength > 32) fail(iface.name + ": IPv4 prefixLength " + ad.prefixLength);
      if (ad.broadcast != null && ad.broadcast.length > 0 && !isDottedQuad(ad.broadcast)) {
        fail(iface.name + ": broadcast is not dotted-quad: " + ad.broadcast);
      }
    } else {
      if (ad.address.toLowerCase().indexOf("fe80") == 0) {
        fail(iface.name + ": an IPv6 link-local address must not be reported: " + ad.address);
      }
      if (ad.prefixLength < 0 || ad.prefixLength > 128) fail(iface.name + ": IPv6 prefixLength " + ad.prefixLength);
      if (ad.broadcast != null && ad.broadcast.length > 0) fail(iface.name + ": IPv6 has no broadcast, got " + ad.broadcast);
    }
    if (ad.broadcast == null) fail(iface.name + ": broadcast should be \"\" when absent, not null");
  }
}

trace("interfaces=" + first.length + " withHardwareAddress=" + withMac + " names=[" + seenNames.join(",") + "]");
trace("net-interfaces ok");