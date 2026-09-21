// Stage3D Shoot-em-up Tutorial Part 1
// by Christer Kaitila - www.mcfunkypants.com

// LiteSpriteBatch.as
// An optimization used to increase performance that renders multiple
// sprites in a single pass by grouping all polygons together,
// allowing stage3D to treat it as a single mesh that can be
// rendered in a single drawTriangles call. 
// Each frame, the positions of each
// vertex is updated and re-uploaded to video ram.
// Based on example code by Chris Nuuja which is a port
// of the haXe+NME bunnymark demo by Philippe Elsass
// which is itself a port of Iain Lobb's original work.
// Also includes code from the Starling framework.
// Grateful acknowledgements to all involved.

package
{
    import com.adobe.utils.AGALMiniAssembler;
    
    import flash.display.BitmapData;
    import flash.display3D.Context3D;
    import flash.display3D.Context3DBlendFactor;
    import flash.display3D.Context3DCompareMode;
    import flash.display3D.Context3DProgramType;
    import flash.display3D.Context3DTextureFormat;
    import flash.display3D.Context3DVertexBufferFormat;
    import flash.display3D.IndexBuffer3D;
    import flash.display3D.Program3D;
    import flash.display3D.VertexBuffer3D;
    import flash.display3D.textures.Texture;
    import flash.geom.Matrix;
    import flash.geom.Matrix3D;
    import flash.geom.Point;
    import flash.geom.Rectangle;
    
    public class LiteSpriteBatch
    {
        internal var _sprites : LiteSpriteSheet;        
        internal var _verteces : Vector.<Number>;
        internal var _indeces : Vector.<uint>;
        internal var _uvs : Vector.<Number>;
        
        protected var _context3D : Context3D;
        protected var _parent : LiteSpriteStage;
        protected var _children : Vector.<LiteSprite>;

        protected var _indexBuffer : IndexBuffer3D;
        protected var _vertexBuffer : VertexBuffer3D;
        protected var _uvBuffer : VertexBuffer3D;
        protected var _shader : Program3D;
        protected var _updateVBOs : Boolean;


        public function LiteSpriteBatch(context3D:Context3D, spriteSheet:LiteSpriteSheet)
        {
            _context3D = context3D;
            _sprites = spriteSheet;
            
            _verteces = new Vector.<Number>();
            _indeces = new Vector.<uint>();
            _uvs = new Vector.<Number>();
            
            _children = new Vector.<LiteSprite>;
            _updateVBOs = true;
            setupShaders();
            updateTexture();  
        }
        
        public function get parent() : LiteSpriteStage
        {
            return _parent;
        }
        
        public function set parent(parentStage:LiteSpriteStage) : void
        {
            _parent = parentStage;
        }
        
        public function get numChildren() : uint
        {
            return _children.length;
        }
        
        // Constructs a new child sprite and attaches it to the batch
        public function createChild(spriteId:uint) : LiteSprite
        {
            var sprite : LiteSprite = new LiteSprite();
            addChild(sprite, spriteId);
            return sprite;
        }
        
        public function addChild(sprite:LiteSprite, spriteId:uint) : void
        {
            sprite._parent = this;
            sprite._spriteId = spriteId;
            
            // Add to list of children
            sprite._childId = _children.length;
            _children.push(sprite);

            // Add vertex data required to draw child
            var childVertexFirstIndex:uint = (sprite._childId * 12) / 3; 
            _verteces.push(0, 0, 1, 0, 0,1, 0, 0,1, 0, 0,1); // placeholders
            _indeces.push(childVertexFirstIndex, childVertexFirstIndex+1, childVertexFirstIndex+2, childVertexFirstIndex, childVertexFirstIndex+2, childVertexFirstIndex+3);

            var childUVCoords:Vector.<Number> = _sprites.getUVCoords(spriteId); 
            _uvs.push(
                childUVCoords[0], childUVCoords[1], 
                childUVCoords[2], childUVCoords[3],
                childUVCoords[4], childUVCoords[5],
                childUVCoords[6], childUVCoords[7]);
            
            _updateVBOs = true;
        }
        
        public function removeChild(child:LiteSprite) : void
        {
            var childId:uint = child._childId;
            if ( (child._parent == this) && childId < _children.length ) {
                child._parent = null;
                _children.splice(childId, 1);
                
                // Update child id (index into array of children) for remaining children
                var idx:uint;
                for ( idx = childId; idx < _children.length; idx++ ) {
                    _children[idx]._childId = idx;
                }
                
                // Realign vertex data with updated list of children
                var vertexIdx:uint = childId * 12;
                var indexIdx:uint= childId * 6;
                _verteces.splice(vertexIdx, 12);
                _indeces.splice(indexIdx, 6);
                _uvs.splice(vertexIdx, 8);
                
                _updateVBOs = true;
            }
        }
        
        protected function setupShaders() : void
        {
            var vertexShaderAssembler:AGALMiniAssembler = new AGALMiniAssembler();
            vertexShaderAssembler.assemble( Context3DProgramType.VERTEX,
                "dp4 op.x, va0, vc0 \n"+ // transform from stream 0 to output clipspace
                "dp4 op.y, va0, vc1 \n"+ // do the same for the y coordinate
                "mov op.z, vc2.z    \n"+ // we don't need to change the z coordinate
                "mov op.w, vc3.w    \n"+ // unused, but we need to output all data
                "mov v0, va1.xy     \n"+ // copy UV coords from stream 1 to fragment program
				"mov v0.z, va0.z    \n"  // copy alpha from stream 0 to fragment program
            );
			
            var fragmentShaderAssembler:AGALMiniAssembler = new AGALMiniAssembler();
            fragmentShaderAssembler.assemble( Context3DProgramType.FRAGMENT,
                "tex ft0, v0, fs0 <2d,clamp,linear,mipnearest> \n"+ // sample the texture
				"mul ft0, ft0, v0.zzzz\n" + // multiply by the alpha transparency
                "mov oc, ft0 \n" // output the final pixel color 
            );
            
            _shader = _context3D.createProgram();
            _shader.upload( vertexShaderAssembler.agalcode, fragmentShaderAssembler.agalcode );
        }
        
        protected function updateTexture() : void
        {
            _sprites.uploadTexture(_context3D);    
        }
        
        protected function updateChildVertexData(sprite:LiteSprite) : void
        {
            var childVertexIdx:uint = sprite._childId * 12;

            if ( sprite.visible ) {
                var x:Number = sprite.position.x;
                var y:Number = sprite.position.y;
                var rect:Rectangle = sprite.rect;
                var sinT:Number = Math.sin(sprite.rotation);
                var cosT:Number = Math.cos(sprite.rotation);
				var alpha:Number = sprite.alpha;
                
                var scaledWidth:Number = rect.width * sprite.scaleX;
                var scaledHeight:Number = rect.height * sprite.scaleY;
                var centerX:Number = scaledWidth * 0.5;
                var centerY:Number = scaledHeight * 0.5;
                
                _verteces[childVertexIdx] = x - (cosT * centerX) - (sinT * (scaledHeight - centerY));
                _verteces[childVertexIdx+1] = y - (sinT * centerX) + (cosT * (scaledHeight - centerY));
				_verteces[childVertexIdx+2] = alpha;
				
                _verteces[childVertexIdx+3] = x - (cosT * centerX) + (sinT * centerY);
                _verteces[childVertexIdx+4] = y - (sinT * centerX) - (cosT * centerY);
				_verteces[childVertexIdx+5] = alpha;
				
                _verteces[childVertexIdx+6] = x + (cosT * (scaledWidth - centerX)) + (sinT * centerY);
                _verteces[childVertexIdx+7] = y + (sinT * (scaledWidth - centerX)) - (cosT * centerY);
				_verteces[childVertexIdx+8] = alpha;
				
                _verteces[childVertexIdx+9] = x + (cosT * (scaledWidth - centerX)) - (sinT * (scaledHeight - centerY));
                _verteces[childVertexIdx+10] = y + (sinT * (scaledWidth - centerX)) + (cosT * (scaledHeight - centerY));
				_verteces[childVertexIdx+11] = alpha;
				
            }
            else {
                for (var i:uint = 0; i < 12; i++ ) {
                    _verteces[childVertexIdx+i] = 0;
                }
            }
        }
        
		public function draw() : void
        {
            var nChildren:uint = _children.length;
            if ( nChildren == 0 ) return;
            
            // Update vertex data with current position of children
            for ( var i:uint = 0; i < nChildren; i++ ) {
                updateChildVertexData(_children[i]);
            }
            
            _context3D.setProgram(_shader);
            _context3D.setBlendFactors(Context3DBlendFactor.ONE, Context3DBlendFactor.ONE_MINUS_SOURCE_ALPHA);            
            _context3D.setProgramConstantsFromMatrix(Context3DProgramType.VERTEX, 0, _parent.modelViewMatrix, true); 
            _context3D.setTextureAt(0, _sprites._texture);
            
            if ( _updateVBOs ) {
				_vertexBuffer = _context3D.createVertexBuffer(_verteces.length/3, 3);   
				_indexBuffer = _context3D.createIndexBuffer(_indeces.length);
				_uvBuffer = _context3D.createVertexBuffer(_uvs.length/2, 2);
				_indexBuffer.uploadFromVector(_indeces, 0, _indeces.length); // indices won't change                
				_uvBuffer.uploadFromVector(_uvs, 0, _uvs.length / 2); // child UVs won't change
				_updateVBOs = false;
			}
			
            // we want to upload the vertex data every frame
			_vertexBuffer.uploadFromVector(_verteces, 0, _verteces.length / 3);
            _context3D.setVertexBufferAt(0, _vertexBuffer, 0, Context3DVertexBufferFormat.FLOAT_3);
            _context3D.setVertexBufferAt(1, _uvBuffer, 0, Context3DVertexBufferFormat.FLOAT_2);
            
            _context3D.drawTriangles(_indexBuffer, 0,  nChildren * 2);
        }
    } // end class
} // end package