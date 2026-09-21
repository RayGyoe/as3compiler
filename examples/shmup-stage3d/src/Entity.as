// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// Entity.as
// The Entity class will eventually hold all game-specific entity logic
// for the spaceships, bullets and effects in our game. For now,
// it simply holds a reference to a gpu sprite and a few demo properties.
// This is where you would add hit points, weapons, ability scores, etc.

package
{
	public class Entity
	{
		private var _speedX : Number;
		private var _speedY : Number;
		private var _sprite : LiteSprite;
		public var active : Boolean = true;
		
		public function Entity(gs:LiteSprite = null)
		{
			_sprite = gs;
			_speedX = 0.0;
			_speedY = 0.0;
		}
		
		public function die() : void
		{
			// allow this entity to be reused by the entitymanager
			active = false;
			// skip all drawing and updating
			sprite.visible = false;
		}
		
		public function get speedX() : Number 
		{
			return _speedX;
		}
		public function set speedX(sx:Number) : void 
		{
			_speedX = sx;
		}
		public function get speedY() : Number 
		{
			return _speedY;
		}
		public function set speedY(sy:Number) : void 
		{
			_speedY = sy;
		}
		public function get sprite():LiteSprite 
		{	
			return _sprite;
		}
		public function set sprite(gs:LiteSprite):void 
		{
			_sprite = gs;
		}
	} // end class
} // enDate package