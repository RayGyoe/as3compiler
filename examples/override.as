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
  function Dog(n:String) {
    super(n);
    this.name = n;
  }
  override function speak():String {
    return this.name + " barks";
  }
}

class Cat extends Animal {
  function Cat(n:String) {
    super(n);
    this.name = n;
  }
  override function speak():String {
    return this.name + " meows";
  }
}

var a:Animal = new Dog("Rex");
trace(a.speak());

var b:Animal = new Cat("Whiskers");
trace(b.speak());

var c:Animal = new Animal("generic");
trace(c.speak());
