// http-request-api.as — stage 89·48, phase A of docs/zh-cn/flash-net.md:
// the flash.net SEMANTIC SURFACE, with no network involvement whatsoever.
//
// Everything asserted here is observable without a network stack: the constant
// tables, URLRequestHeader, the URLRequestDefaults -> URLRequest default link,
// URLVariables.decode(), and the URL string algebra of useRedirectedURL(). What
// this example deliberately does NOT touch is HTTP itself — URLLoader still reads
// the URL as a local filesystem path (see examples/urlloader-contract.as for the
// contract around that read, and docs/zh-cn/flash-net.md §5-C..I for the client).

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- URLRequestMethod: all six documented constants, not just GET/POST ---
check(URLRequestMethod.GET == "GET", "URLRequestMethod.GET");
check(URLRequestMethod.POST == "POST", "URLRequestMethod.POST");
check(URLRequestMethod.PUT == "PUT", "URLRequestMethod.PUT");
check(URLRequestMethod.DELETE == "DELETE", "URLRequestMethod.DELETE");
check(URLRequestMethod.HEAD == "HEAD", "URLRequestMethod.HEAD");
check(URLRequestMethod.OPTIONS == "OPTIONS", "URLRequestMethod.OPTIONS");

// --- URLRequestHeader: name/value pair, both defaulting to "" ---
var bare:URLRequestHeader = new URLRequestHeader();
check(bare.name == "" && bare.value == "", "URLRequestHeader defaults to empty strings");
var ct:URLRequestHeader = new URLRequestHeader("Content-Type", "text/html");
check(ct.name == "Content-Type" && ct.value == "text/html", "URLRequestHeader stores name/value");
ct.value = "application/json";
check(ct.value == "application/json", "URLRequestHeader.value is writable");

// --- URLRequest: adl-measured defaults ---
var req:URLRequest = new URLRequest("http://www.example.com/api/form.jsp");
check(req.method == URLRequestMethod.GET, "method defaults to GET");
check(req.data == null, "data defaults to null");
// NULL is correct: adl returns null here. The "application/x-www-form-urlencoded"
// the reference documentation prints is the Content-Type adl puts on the WIRE for
// a request that carries a body and declared none -- a different thing.
check(req.contentType == null, "contentType defaults to null (adl)");
check(req.authenticate == true, "authenticate defaults to true");
check(req.cacheResponse == true, "cacheResponse defaults to true");
check(req.followRedirects == true, "followRedirects defaults to true");
check(req.idleTimeout == 0, "idleTimeout defaults to 0");
check(req.manageCookies == true, "manageCookies defaults to true");
check(req.useCache == true, "useCache defaults to true");
check(req.requestHeaders != null, "requestHeaders is a usable Array, not null");
check(req.requestHeaders.length == 0, "requestHeaders starts empty");
check(req.digest == null, "digest defaults to null");

// Adobe's own documented idiom: push a header onto a fresh request.
req.requestHeaders.push(ct);
check(req.requestHeaders.length == 1, "requestHeaders.push works on a fresh URLRequest");
var got:URLRequestHeader = req.requestHeaders[0] as URLRequestHeader;
check(got.name == "Content-Type", "the pushed header is retrievable");

// The default user agent is the OS-derived Flash/AIR-style string.
check(req.userAgent != null, "userAgent has a default");
check(req.userAgent.indexOf("AdobeAIR/") >= 0, "default userAgent carries the AdobeAIR token");
check(req.userAgent.indexOf("Mozilla/5.0") == 0, "default userAgent has the Flash/WebKit shape");

// --- URLRequestDefaults: the static defaults URLRequest initializes from ---
check(URLRequestDefaults.authenticate == true, "URLRequestDefaults.authenticate default");
check(URLRequestDefaults.cacheResponse == true, "URLRequestDefaults.cacheResponse default");
check(URLRequestDefaults.followRedirects == true, "URLRequestDefaults.followRedirects default");
check(URLRequestDefaults.idleTimeout == 0, "URLRequestDefaults.idleTimeout default");
check(URLRequestDefaults.manageCookies == true, "URLRequestDefaults.manageCookies default");
check(URLRequestDefaults.useCache == true, "URLRequestDefaults.useCache default");
check(URLRequestDefaults.userAgent.indexOf("AdobeAIR/") >= 0, "URLRequestDefaults.userAgent default");

// Changing a default must be visible to every URLRequest built afterwards
// ("initialized from the URLRequestDefaults.<name> property" per the AIR docs).
URLRequestDefaults.followRedirects = false;
URLRequestDefaults.idleTimeout = 1500;
URLRequestDefaults.authenticate = false;
URLRequestDefaults.cacheResponse = false;
URLRequestDefaults.manageCookies = false;
URLRequestDefaults.useCache = false;
// A GC string, not a literal: this is what makes the static a GC root.
URLRequestDefaults.userAgent = "TestAgent" + "/" + "v2";
check(URLRequestDefaults.followRedirects == false, "URLRequestDefaults is writable");
check(URLRequestDefaults.idleTimeout == 1500, "URLRequestDefaults.idleTimeout is writable");
check(URLRequestDefaults.userAgent == "TestAgent/v2", "URLRequestDefaults.userAgent is writable");

var req2:URLRequest = new URLRequest("http://www.example.com/");
check(req2.followRedirects == false, "URLRequest.followRedirects reads the changed default");
check(req2.idleTimeout == 1500, "URLRequest.idleTimeout reads the changed default");
check(req2.authenticate == false, "URLRequest.authenticate reads the changed default");
check(req2.cacheResponse == false, "URLRequest.cacheResponse reads the changed default");
check(req2.manageCookies == false, "URLRequest.manageCookies reads the changed default");
check(req2.useCache == false, "URLRequest.useCache reads the changed default");
check(req2.userAgent == "TestAgent/v2", "URLRequest.userAgent reads the changed default");

// The assignment happens at construction time, so an already-built request keeps
// the value it was handed (AIR initializes the property, it does not alias it).
URLRequestDefaults.userAgent = "LaterAgent/1.0";
check(req2.userAgent == "TestAgent/v2", "a built URLRequest is not retroactively changed");

// The static must survive a collection: it is registered as a permanent GC root.
System.gc();
check(URLRequestDefaults.userAgent == "LaterAgent/1.0", "URLRequestDefaults.userAgent survives GC");
check(new URLRequest("http://www.example.com/").userAgent == "LaterAgent/1.0", "…and is still handed to new requests");

// --- URLVariables.decode(): the read side of the query-string serializer ---
var vars:URLVariables = new URLVariables();
vars.decode("first=1&second=hello%20world&third=");
check(vars.first == "1", "decode() sets a numeric-looking value as a String");
check(vars.second == "hello world", "decode() percent-decodes values");
check(vars.third == "", "decode() keeps an empty value");
vars.decode("only=one");
check(vars.only == "one", "decode() can be called again on the same instance");
// Keys are not percent-decoded (AIR's asymmetry: values are decoded, keys are not).
var vars2:URLVariables = new URLVariables("a%20b=c%20d");
check(vars2["a%20b"] == "c d", "decode() decodes values but not keys");
check(vars2.toString().indexOf("a%20b=c+d") >= 0 || vars2.toString().indexOf("a%20b=c%20d") >= 0,
      "decoded variables round-trip through toString()");

// --- useRedirectedURL(): domain substitution, then pattern replacement ---
// A "source" request that has already been redirected to a CDN.
var src:URLRequest = new URLRequest("http://cdn.example.com/assets/image.png");

// Default (wholeURL = false): take the source DOMAIN, keep this URL's own path.
var d1:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d1.useRedirectedURL(src);
check(d1.url == "http://cdn.example.com/img/logo.png", "useRedirectedURL substitutes the domain");

// wholeURL = true: take the source's entire URL minus filename, keep this filename.
var d2:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d2.useRedirectedURL(src, true);
check(d2.url == "http://cdn.example.com/assets/logo.png", "useRedirectedURL(wholeURL) substitutes the directory");

// String pattern: searched for AFTER the substitution (AIR documents that order).
var d3:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d3.useRedirectedURL(src, false, "example.com", "example.org");
check(d3.url == "http://cdn.example.org/img/logo.png", "useRedirectedURL applies a String pattern");

// RegExp pattern: same, and provably applied to the post-substitution URL — the
// pre-substitution host no longer exists by then, so this matches nothing.
var d4:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d4.useRedirectedURL(src, false, /www\.example\.com/, "never.example.com");
check(d4.url == "http://cdn.example.com/img/logo.png", "a RegExp pattern runs after the substitution");

var d5:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d5.useRedirectedURL(src, false, /cdn\.example/, "assets.example");
check(d5.url == "http://assets.example.com/img/logo.png", "useRedirectedURL applies a RegExp pattern");

// A null source (or a source with no URL) is a documented no-op.
var d6:URLRequest = new URLRequest("http://www.example.com/img/logo.png");
d6.useRedirectedURL(new URLRequest());
check(d6.url == "http://www.example.com/img/logo.png", "a source without a URL leaves this URL alone");

// The source is not mutated: only the receiver changes.
check(src.url == "http://cdn.example.com/assets/image.png", "useRedirectedURL leaves the source request alone");

System.output("http-request-api: all URLRequest/URLRequestMethod/URLRequestHeader/URLRequestDefaults assertions passed\n");