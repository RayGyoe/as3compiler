// vendor/sysproxy_glue.c — the operating system's proxy configuration, for the
// native flash.net HTTP backend (stage 89·53, `ASC_SYSTEM_PROXY`).
//
// Why this is a SEPARATE translation unit rather than a few lines in the runtime
// preamble that the compiler emits:
//
//   <SystemConfiguration/SystemConfiguration.h> — and even
//   <CoreFoundation/CoreFoundation.h> on its own — drags in MacTypes.h, which
//   defines `struct Point`. The generated C declares `struct Point` for the
//   AS3 class `flash.geom.Point`, so including any of those headers in it is a
//   hard redefinition error. Isolating the Apple headers here keeps the emitted
//   `.c` header-free and readable, which is the whole point of the single-file
//   output (AGENTS.md §1.3). The generated code only sees the plain-C prototype:
//
//       extern int as_sysproxy_get(const char* url, char* proxy, int proxy_cap,
//                                  char* noproxy, int noproxy_cap);
//
// AIR has no AS3 proxy API: it uses the system settings, which is what this file
// reads. libcurl's own *_proxy environment variables are handled by libcurl and
// take precedence — the caller only reaches here when none is exported, so an
// explicitly exported proxy is never overridden.
//
// Build: add `"sources": ["<vendor>/sysproxy_glue.c"]` and
// `-framework SystemConfiguration` (CoreFoundation comes along with it) to the
// manifest, plus the define `ASC_SYSTEM_PROXY`.

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include <SystemConfiguration/SystemConfiguration.h>

// Copy a CFString into a fixed caller buffer. Returns 0 when there is nothing to
// copy (NULL, or the UTF-8 form does not fit) — a proxy value that does not fit is
// dropped rather than truncated, because a truncated "host:port" is a wrong
// destination, not a smaller one.
static int copy_cfstring(CFStringRef s, char* out, int cap) {
    if (s == NULL || cap <= 0) return 0;
    out[0] = '\0';
    return CFStringGetCString(s, out, (CFIndex)cap, kCFStringEncodingUTF8) ? 1 : 0;
}

int as_sysproxy_get(const char* url, char* proxy, int proxy_cap, char* noproxy, int noproxy_cap) {
    CFDictionaryRef d;
    CFNumberRef en;
    CFStringRef host;
    CFNumberRef port;
    int https, on = 0, pn = 0, found = 0;

    if (proxy != NULL && proxy_cap > 0) proxy[0] = '\0';
    if (noproxy != NULL && noproxy_cap > 0) noproxy[0] = '\0';
    if (url == NULL) return 0;

    https = (strncmp(url, "https:", 6) == 0);
    d = SCDynamicStoreCopyProxies(NULL);
    if (d == NULL) return 0;

    // SystemConfiguration keeps the HTTP and HTTPS entries apart. Prefer the one
    // matching the scheme, then fall back to the plain HTTP entry: a machine that
    // only enables "Web Proxy (HTTP)" is the common case, and an HTTP proxy
    // forwards https:// through CONNECT anyway.
    en = (CFNumberRef)CFDictionaryGetValue(d, https ? kSCPropNetProxiesHTTPSEnable : kSCPropNetProxiesHTTPEnable);
    if (en != NULL) CFNumberGetValue(en, kCFNumberIntType, &on);
    if (!on && https) {
        en = (CFNumberRef)CFDictionaryGetValue(d, kSCPropNetProxiesHTTPEnable);
        if (en != NULL) CFNumberGetValue(en, kCFNumberIntType, &on);
        host = (CFStringRef)CFDictionaryGetValue(d, kSCPropNetProxiesHTTPProxy);
        port = (CFNumberRef)CFDictionaryGetValue(d, kSCPropNetProxiesHTTPPort);
    } else {
        host = (CFStringRef)CFDictionaryGetValue(d, https ? kSCPropNetProxiesHTTPSProxy : kSCPropNetProxiesHTTPProxy);
        port = (CFNumberRef)CFDictionaryGetValue(d, https ? kSCPropNetProxiesHTTPSPort : kSCPropNetProxiesHTTPPort);
    }

    if (on && host != NULL && proxy != NULL && proxy_cap > 0) {
        char h[400];
        if (copy_cfstring(host, h, (int)sizeof(h))) {
            if (port != NULL) CFNumberGetValue(port, kCFNumberIntType, &pn);
            if (pn > 0) snprintf(proxy, (size_t)proxy_cap, "%s:%d", h, pn);
            else snprintf(proxy, (size_t)proxy_cap, "%s", h);
            found = 1;
        }
    }

    // "Bypass proxy settings for these hosts". libcurl's no_proxy takes the same
    // comma-separated shape, including domain suffixes and "*" wildcards; entries
    // this build cannot express (CIDR ranges, "<local>") are passed through as-is
    // because libcurl simply will not match them — a wider proxy scope, never a
    // silent redirect of a host the user wanted direct.
    if (noproxy != NULL && noproxy_cap > 0) {
        CFArrayRef ex = (CFArrayRef)CFDictionaryGetValue(d, kSCPropNetProxiesExceptionsList);
        if (ex != NULL && CFArrayGetCount(ex) > 0) {
            CFIndex i, n = CFArrayGetCount(ex);
            int at = 0;
            for (i = 0; i < n; i++) {
                char item[300];
                if (!copy_cfstring((CFStringRef)CFArrayGetValueAtIndex(ex, i), item, (int)sizeof(item))) continue;
                int need = (int)strlen(item) + (at > 0 ? 1 : 0);
                if (at + need >= noproxy_cap) break;
                if (at > 0) noproxy[at++] = ',';
                memcpy(noproxy + at, item, strlen(item) + 1);
                at += (int)strlen(item);
            }
            if (at > 0) found = 1;
        }
    }

    CFRelease(d);
    return found;
}