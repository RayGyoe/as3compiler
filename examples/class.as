// class.as — class, fields, methods, new, this
class Counter {
    var total:int = 0;
    var label:String = "counter";

    function inc(n:int):int {
        total += n;
        return total;
    }

    function describe():String {
        return label + " total=" + total;
    }
}

var c:Counter = new Counter();
trace(c.describe());

var i:int = 0;
while (i < 5) {
    c.inc(10);
    trace("after inc:", c.total);
    i++;
}

trace(c.describe());
trace("label length =", c.label.length);
