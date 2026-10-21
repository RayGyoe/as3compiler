// Regression for 阶段二百三十六 (trace() of an AS3-null String).
//
// A statically String-typed slot holds the AS3 null as C NULL, and String(null) is
// the four characters "null". The trace emitter used to hand that NULL straight to
// printf("%s"), which is not merely wrong output: Windows ucrt rejects the null
// pointer through _invalid_parameter -> __fastfail(FAST_FAIL_INVALID_ARG) and kills
// the process with 0xC0000409 (measured on the TalkMED gift panel, where
// GiftListView.updateList() does trace(targetUrl) with targetUrl:String = null and
// clang folds printf("%s\n") into puts), while Apple libc quietly prints "(null)".
class NullStrHolder {
    // Never assigned: must stay AS3 null (C NULL), which is what reaches trace().
    public var neverSet:String;
    public var empty:String = "";
}

var h:NullStrHolder = new NullStrHolder();
var a:String = null;
trace(a);
trace(h.neverSet);
trace("a=" + a);
trace(h.empty);
if (a == null && h.neverSet == null && h.empty == "") {
    trace("trace-null ok");
} else {
    trace("trace-null BROKEN");
}