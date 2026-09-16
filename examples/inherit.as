class Animal {
  var name:String = "animal";
  function Animal(n:String) {
    this.name = n;
  }
  function speak():String {
    return this.name;
  }
}

class Dog extends Animal {
  var breed:String = "unknown";
  function Dog(n:String, b:String) {
    super(n);
    this.name = n;
    this.breed = b;
  }
  function describe():String {
    return this.breed + " " + this.name;
  }
}

var d = new Dog("Buddy", "Labrador");
trace(d.speak());
trace(d.describe());
trace(d.name);
trace(d.breed);

var a = new Animal("generic");
trace(a.speak());
