// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// LiteSprite.as
// A 2d sprite that is rendered by Stage3D as a textured quad
// (two triangles) to take advantage of hardware acceleration.
// Based on example code by Chris Nuuja which is a port
// of the haXe+NME bunnymark demo by Philippe Elsass
// which is itself a port of Iain Lobb's original work.
// Also includes code from the Starling framework.
// Grateful acknowledgements to all involved.

package
{
    import flash.geom.Point;
    import flash.geom.Rectangle;
    
    public class LiteSprite
    {
        internal var _parent : LiteSpriteBatch;        
        internal var _spriteId : uint;
        internal var _childId : uint;
        private var _pos : Point;
        private var _visible : Boolean;
        private var _scaleX : Number;
        private var _scaleY : Number;
        private var _rotation : Number;
        private var _alpha : Number;

        public function get visible() : Boolean
        {
            return _visible;
        }
        public function set visible(isVisible:Boolean) : void
        {
            _visible = isVisible;
        }
		public function get alpha() : Number 
		{
			return _alpha;
		}
		public function set alpha(a:Number) : void 
		{
			_alpha = a;
		}
        public function get position() : Point
        {
            return _pos;
        }
        public function set position(pt:Point) : void
        {
            _pos = pt;
        }
        public function get scaleX() : Number
        {
            return _scaleX;
        }
        public function set scaleX(val:Number) : void
        {
            _scaleX = val;
        }
        public function get scaleY() : Number
        {
            return _scaleY;
        }
        public function set scaleY(val:Number) : void
        {
            _scaleY = val;
        }
        public function get rotation() : Number
        {
            return _rotation;
        }
        public function set rotation(val:Number) : void
        {
            _rotation = val;    
        }
        public function get rect() : Rectangle
        {
            return _parent._sprites.getRect(_spriteId);
        }
        public function get parent() : LiteSpriteBatch
        {
            return _parent;
        }
        public function get spriteId() : uint
        {
            return _spriteId;
        }
        public function set spriteId(num : uint) : void
        {
            _spriteId = num;
        }
        public function get childId() : uint
        {
            return _childId;
        }
        
        // LiteSprites are typically constructed by calling LiteSpriteBatch.createChild()
        public function LiteSprite()
        {
            _parent = null;
            _spriteId = 0;
            _childId = 0;
            _pos = new Point();
            _scaleX = 1.0;
            _scaleY = 1.0;
            _rotation = 0;
            _alpha = 1.0;
            _visible = true;
        }
    } // end class
} // end package