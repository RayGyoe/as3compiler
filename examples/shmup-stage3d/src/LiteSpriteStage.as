// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// LiteSpriteStage.as
// The stage3D renderer of any number of batched geometry
// meshes of multiple sprites. Handles stage3D inits, etc.
// Based on example code by Chris Nuuja which is a port
// of the haXe+NME bunnymark demo by Philippe Elsass
// which is itself a port of Iain Lobb's original work.
// Also includes code from the Starling framework.
// Grateful acknowledgements to all involved.

package
{
    import flash.display.Stage3D;
    import flash.display3D.Context3D;
    import flash.geom.Matrix3D;
    import flash.geom.Rectangle;
	
    public class LiteSpriteStage
    {
        protected var _stage3D : Stage3D;
        protected var _context3D : Context3D;        
        protected var _rect : Rectangle;
        protected var _batches : Vector.<LiteSpriteBatch>;
        protected var _modelViewMatrix : Matrix3D;
        
        public function LiteSpriteStage(stage3D:Stage3D, context3D:Context3D, rect:Rectangle)
        {
            _stage3D = stage3D;
            _context3D = context3D;
            _batches = new Vector.<LiteSpriteBatch>;
            
            this.position = rect;
        }
        
        public function get position() : Rectangle
        {
            return _rect;
        }
        
        public function set position(rect:Rectangle) : void
        {
            _rect = rect;
            _stage3D.x = rect.x;
            _stage3D.y = rect.y;
            configureBackBuffer(rect.width, rect.height);
            
            _modelViewMatrix = new Matrix3D();
            _modelViewMatrix.appendTranslation(-rect.width/2, -rect.height/2, 0);            
            _modelViewMatrix.appendScale(2.0/rect.width, -2.0/rect.height, 1);
        }
        
        internal function get modelViewMatrix() : Matrix3D
        {
            return _modelViewMatrix;
        }
        
        public function configureBackBuffer(width:uint, height:uint) : void
        {
             _context3D.configureBackBuffer(width, height, 0, false);
        }
 
        public function addBatch(batch:LiteSpriteBatch) : void
        {
            batch.parent = this;
            _batches.push(batch);
        }
        
        public function removeBatch(batch:LiteSpriteBatch) : void
        {
            for ( var i:uint = 0; i < _batches.length; i++ ) {
                if ( _batches[i] == batch ) {
                    batch.parent = null;
                    _batches.splice(i, 1);
                }
            }
        }
        
		// loop through all batches 
		// (this demo uses only one)
		// and tell them to draw themselves
		public function render() : void
		{
			for ( var i:uint = 0; i < _batches.length; i++ ) {
				_batches[i].draw();       
			}
		}
    } // end class
} // end package