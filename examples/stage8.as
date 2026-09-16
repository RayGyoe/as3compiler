// bitwise operators
var a:int = 0xF0;   // 240 = 11110000
var b:int = 0x0F;   // 15  = 00001111

trace("a & b =", a & b);   // 0
trace("a | b =", a | b);   // 255
trace("a ^ b =", a ^ b);   // 255
trace("~a =", ~a);         // -241
trace("a << 1 =", a << 1); // 480
trace("a >> 4 =", a >> 4); // 15
trace("b >>> 1 =", b >>> 1); // 7

// compound assignment
var c:int = 0x0F;
c <<= 4;
trace("c <<= 4 ->", c);
c &= 0xFF;
trace("c &= 0xFF ->", c);
c |= 0x0F;
trace("c |= 0x0F ->", c);
c ^= 0x0F;
trace("c ^= 0x0F ->", c);
c >>= 4;
trace("c >>= 4 ->", c);

// labeled break
var sum:int = 0;
outer: while (true) {
  for (var i:int = 0; i < 10; i++) {
    if (i == 3) continue;
    sum += i;
    if (sum > 20) break outer;
  }
}
trace("sum =", sum);

// labeled continue
var total:int = 0;
var j:int = 0;
loop: while (j < 10) {
  j++;
  if (j % 2 == 0) continue loop;
  total += j;
}
trace("total =", total);

trace("done");
