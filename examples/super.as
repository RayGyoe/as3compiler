class Animal {
  var name:String = "animal";
  function Animal(n:String) {
    this.name = n;
  }
  function speak():String {
    return this.name + " makes a sound";
  }
}

class Dog extends Animal {
  var breed:String = "unknown";
  function Dog(n:String, b:String) {
    super(n);
    this.breed = b;
  }
  override function speak():String {
    return super.speak() + " (actually a dog)";
  }
}

var d = new Dog("Rex", "Labrador");
trace(d.name);
trace(d.breed);
trace(d.speak());
