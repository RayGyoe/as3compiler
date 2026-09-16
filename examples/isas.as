class Animal {
  function speak():String {
    return "animal";
  }
}

class Dog extends Animal {
  override function speak():String {
    return "dog";
  }
}

var a:Animal = new Dog();
trace(a is Dog);
trace(a is Animal);

var b:Animal = new Animal();
trace(b is Dog);

var d:Dog = a as Dog;
trace(d.speak());

var e:Dog = b as Dog;
trace(e == null);
