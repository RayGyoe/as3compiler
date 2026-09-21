// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// LiteSpriteSheet.as
// An optimization used to improve performance, all sprites used
// in the game are packed onto a single texture so that
// they can be rendered in a single pass rather than individually.
// This also avoids the performance penalty of 3d stage changes.
// Based on example code by Chris Nuuja which is a port
// of the haXe+NME bunnymark demo by Philippe Elsass
// which is itself a port of Iain Lobb's original work.
// Also includes code from the Starling framework.
// Grateful acknowledgements to all involved.

package
{
    import flash.display.Bitmap;
    import flash.display.BitmapData;
    import flash.display.Stage;
    import flash.display3D.Context3D;
    import flash.display3D.Context3DTextureFormat;
    import flash.display3D.IndexBuffer3D;
    import flash.display3D.textures.Texture;
    import flash.geom.Point;
    import flash.geom.Rectangle;
    import flash.geom.Matrix;
    
    public class LiteSpriteSheet
    {
        internal var _texture : Texture;
        
        protected var _spriteSheet : BitmapData;    
        protected var _uvCoords : Vector.<Number>;
        protected var _rects : Vector.<Rectangle>;
        
        public function LiteSpriteSheet(SpriteSheetBitmapData:BitmapData, numSpritesW:int = 8, numSpritesH:int = 8)
        {
            _uvCoords = new Vector.<Number>();
            _rects = new Vector.<Rectangle>();
			_spriteSheet = SpriteSheetBitmapData;
			createUVs(numSpritesW, numSpritesH);
		}

        // generate a list of uv coordinates for a grid of sprites
		// on the spritesheet texture for later reference by ID number
		// sprite ID numbers go from left to right then down
		public function createUVs(numSpritesW:int, numSpritesH:int) : void
        {
			trace('creating a '+_spriteSheet.width+'x'+_spriteSheet.height+
				' spritesheet texture with '+numSpritesW+'x'+ numSpritesH+' sprites.');
	
			var destRect : Rectangle;
	
			for (var y:int = 0; y < numSpritesH; y++)
			{
				for (var x:int = 0; x < numSpritesW; x++)
				{
					_uvCoords.push(
						// bl, tl, tr, br	
						x / numSpritesW, (y+1) / numSpritesH,
						x / numSpritesW, y / numSpritesH,
						(x+1) / numSpritesW, y / numSpritesH,
						(x + 1) / numSpritesW, (y + 1) / numSpritesH);
						
					    destRect = new Rectangle();
						destRect.left = 0;
						destRect.top = 0;
						destRect.right = _spriteSheet.width / numSpritesW;
						destRect.bottom = _spriteSheet.height / numSpritesH;
						_rects.push(destRect);					
				}
			}
        }

        public function removeSprite(spriteId:uint) : void
        {
            if ( spriteId < _uvCoords.length ) {
                _uvCoords = _uvCoords.splice(spriteId * 8, 8);
                _rects.splice(spriteId, 1);
            }
        }

        public function get numSprites() : uint
        {
            return _rects.length;
        }

        public function getRect(spriteId:uint) : Rectangle
        {
            return _rects[spriteId];
        }
        
        public function getUVCoords(spriteId:uint) : Vector.<Number>
        {
            var startIdx:uint = spriteId * 8;
            return _uvCoords.slice(startIdx, startIdx + 8);
        }
        
        public function uploadTexture(context3D:Context3D) : void
        {
            if ( _texture == null ) {
                _texture = context3D.createTexture(_spriteSheet.width, _spriteSheet.height, Context3DTextureFormat.BGRA, false);
            }
 
            _texture.uploadFromBitmapData(_spriteSheet);
            
            // generate mipmaps
            var currentWidth:int = _spriteSheet.width >> 1;
            var currentHeight:int = _spriteSheet.height >> 1;
            var level:int = 1;
            var canvas:BitmapData = new BitmapData(currentWidth, currentHeight, true, 0);
            var transform:Matrix = new Matrix(.5, 0, 0, .5);
            
            while ( currentWidth >= 1 || currentHeight >= 1 ) {
                canvas.fillRect(new Rectangle(0, 0, Math.max(currentWidth,1), Math.max(currentHeight,1)), 0);
                canvas.draw(_spriteSheet, transform, null, null, null, true);
                _texture.uploadFromBitmapData(canvas, level++);
                transform.scale(0.5, 0.5);
                currentWidth = currentWidth >> 1;
                currentHeight = currentHeight >> 1;
            }
        }
    } // end class
} // end package