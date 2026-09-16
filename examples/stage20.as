// stage20: Math trigonometric / inverse / exponential / logarithmic functions
// and the six remaining Math constants (v0.3.19).

// Helper: numeric equality within a small epsilon (AS3 has no builtin eps compare).
function near(a:Number, b:Number):Boolean {
  return Math.abs(a - b) < 0.000001;
}

// --- trigonometric (radians) ---
trace(near(Math.sin(Math.PI / 2), 1));   // true
trace(near(Math.cos(0), 1));             // true
trace(near(Math.tan(0), 0));             // true

// --- inverse trigonometric ---
trace(near(Math.asin(1), Math.PI / 2));  // true
trace(near(Math.acos(1), 0));            // true
trace(near(Math.atan(1), Math.PI / 4));  // true
trace(near(Math.atan2(1, 1), Math.PI / 4)); // true

// --- exponential / logarithmic ---
trace(near(Math.exp(1), Math.E));        // true
trace(near(Math.log(Math.E), 1));        // true

// --- constants ---
trace(near(Math.LN10, 2.302585092994046)); // true
trace(near(Math.LN2, 0.6931471805599453)); // true
trace(near(Math.LOG10E, 0.4342944819032518)); // true
trace(near(Math.LOG2E, 1.4426950408889634));  // true
trace(near(Math.SQRT1_2, 0.7071067811865476)); // true
trace(near(Math.SQRT2, 1.4142135623730951));   // true

// --- coexist with existing Math API ---
trace(near(Math.sqrt(2), Math.SQRT2));   // true
trace(near(Math.pow(Math.E, 2), Math.exp(2))); // true
