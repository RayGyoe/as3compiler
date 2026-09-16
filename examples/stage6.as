// stage6.as — package/import syntax compatibility layer (namespaces ignored)

import flash.display.Sprite;
import flash.events.*;

package com.example.game {
    import flash.utils.getTimer;

    function add(a:int, b:int):int {
        return a + b;
    }

    class Player {
        var score:int = 0;
        function bump(n:int):void {
            score = score + n;
        }
    }
}

var p:Player = new Player();
p.bump(10);
p.bump(5);
trace(p.score);      // 15
trace(add(2, 3));    // 5
