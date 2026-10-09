package demo {
  import flash.display.Sprite;
  import flash.display.Shape;	
  import flash.events.MouseEvent;
  import flash.text.TextField;
  import flash.text.TextFormat;
    import flash.text.TextFieldType;
  import flash.utils.setTimeout;
  import demo.windowTest;

	  public class NtWindow extends Sprite {


	  private var box:Sprite;

    public function NtWindow() {

    	// NativeWindow 验收：点这个红块 -> windowTest 第二窗口。
    	//
    	// 这里的写法是本子集里「可绘制 + 可点击」的标准套路（同 examples/
    	// window_click.as）：Sprite 只当命中目标，Shape 负责真正画红块。
    	//
    	// 尺寸必须在**绘制之后**再给：阶段九十四·五起 width/height 是派生访问器
    	// （AIR 语义：测量内容，赋值 = 缩放），给空 Sprite 赋 width 会把 scaleX
    	// 收缩为 0，红块就没了、也点不中了。
    	//
    	// 坐标写在 box 上而不是容器上：渲染与命中测试都按 box.x/box.y 处理，
    	// 两者一致，真实鼠标点击才能落到这个红块上。
    	box = new Sprite();
		  box.x = 410;
		  box.y = 200;

		  var g:Shape = new Shape();
		  g.graphics.beginFill(0xff0000);
		  g.graphics.drawRect(0, 0, 100, 50);
		  g.graphics.endFill();
		  box.addChild(g);

		  box.width = 100;
		  box.height = 50;

		  var txt:TextField = new TextField();
		  txt.mouseEnabled = false;
		  txt.text = "open window";
		  txt.x = txt.y = 10;
		  txt.width = 80;
		  txt.height = 20;
		  box.addChild(txt);

		  box.addEventListener(MouseEvent.CLICK,onclick);

		  addChild(box);


		  var itxt:TextField = new TextField();
		  itxt.type = TextFieldType.INPUT;
      itxt.background = true;
      itxt.backgroundColor = 0xEEEEEE;
      itxt.border = true;
		  itxt.x = 410;
		  itxt.y = 260;
		  addChild(itxt);

      Log.out("=== add NtWindow ===");
		}	
		private function onclick(e:MouseEvent):void{
				box.alpha = 0.6;

				setTimeout(function():void{
				box.alpha = 1;
					},300)

				new windowTest();
		}
  }
}