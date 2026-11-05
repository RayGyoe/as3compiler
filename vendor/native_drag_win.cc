// OLE objects stay on the window STA. No COM object or AS3 pointer crosses threads.
#define NOMINMAX
#include <windows.h>
#include <ole2.h>
#include <shellapi.h>
#include <shlobj.h>
#include <string>
#include <vector>
#include <cstring>
#include <cstdlib>
#include "native_drag.h"
extern "C" void sk_window_get_client_size(int,int*,int*);
static sk_drag_callback callback;
static bool supported;
static UINT urlFormat;
static IDataObject* sourceData;
static int sourceWindow=-1;
static uint64_t sourceSerial;
static int sourceAllowed;
static std::wstring wide(const char* s) {if(!s)return {};int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,NULL,0);if(!n)return {};std::wstring r((size_t)n,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,&r[0],n);r.pop_back();return r;}
static std::string utf8(const wchar_t* s) {if(!s)return {};int n=WideCharToMultiByte(CP_UTF8,0,s,-1,NULL,0,NULL,NULL);if(!n)return {};std::string r((size_t)n,'\0');WideCharToMultiByte(CP_UTF8,0,s,-1,&r[0],n,NULL,NULL);r.pop_back();return r;}
static int effects(DWORD e) {return ((e&DROPEFFECT_COPY)?1:0)|((e&DROPEFFECT_MOVE)?2:0)|((e&DROPEFFECT_LINK)?4:0);}
static DWORD operation(int e) {return ((e&1)?DROPEFFECT_COPY:0)|((e&2)?DROPEFFECT_MOVE:0)|((e&4)?DROPEFFECT_LINK:0);}
static int modifiers(DWORD key) {return ((key&MK_CONTROL)?1:0)|((GetKeyState(VK_MENU)&0x8000)?2:0)|((key&MK_SHIFT)?4:0);}
struct Payload {
 std::vector<std::string> paths;std::vector<const char*> pointers;std::string text,url;bool hasText=false,hasURL=false,local=false;
 sk_drag_data view(){pointers.clear();for(auto& p:paths)pointers.push_back(p.c_str());return {(int)pointers.size(),pointers.data(),hasText?text.c_str():NULL,hasURL?url.c_str():NULL,local?1:0};}
};
static bool readText(IDataObject* obj,UINT format,std::string& out) {
 FORMATETC f={(CLIPFORMAT)format,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL};STGMEDIUM m={};
 if(FAILED(obj->GetData(&f,&m)))return false;
 bool ok=false;if(m.tymed==TYMED_HGLOBAL){const wchar_t* p=(const wchar_t*)GlobalLock(m.hGlobal);if(p){size_t n=GlobalSize(m.hGlobal)/sizeof(wchar_t),i=0;while(i<n&&p[i])i++;if(i<n){out=utf8(p);ok=true;}GlobalUnlock(m.hGlobal);}}
 ReleaseStgMedium(&m);return ok;
}
static Payload readPayload(IDataObject* obj) {
 Payload p;p.local=obj==sourceData;
 FORMATETC f={CF_HDROP,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL};STGMEDIUM m={};
 if(SUCCEEDED(obj->GetData(&f,&m))){if(m.tymed==TYMED_HGLOBAL){UINT n=DragQueryFileW((HDROP)m.hGlobal,0xffffffff,NULL,0);for(UINT i=0;i<n;i++){UINT size=DragQueryFileW((HDROP)m.hGlobal,i,NULL,0);std::wstring path((size_t)size+1,L'\0');if(DragQueryFileW((HDROP)m.hGlobal,i,&path[0],size+1))p.paths.push_back(utf8(path.c_str()));}}ReleaseStgMedium(&m);}
 p.hasText=readText(obj,CF_UNICODETEXT,p.text);p.hasURL=readText(obj,urlFormat,p.url);return p;
}
class Target;
struct Slot {HWND hwnd=NULL;Target* target=NULL;};static Slot slots[16];
static POINT logical(int w,POINT p) {ScreenToClient(slots[w].hwnd,&p);RECT r={};GetClientRect(slots[w].hwnd,&r);int width=0,height=0;sk_window_get_client_size(w,&width,&height);if(r.right>0&&width>0)p.x=MulDiv(p.x,width,r.right);if(r.bottom>0&&height>0)p.y=MulDiv(p.y,height,r.bottom);return p;}
static uint64_t sequence;
class Target:public IDropTarget {
 LONG refs=1;int window;uint64_t serial=0;Payload payload;DWORD allowed=0;
 HRESULT dispatch(int phase,DWORD keys,POINTL screen,DWORD* effect) {
   if(!callback||!slots[window].hwnd){if(effect)*effect=0;return S_OK;}
   POINT p=logical(window,{screen.x,screen.y});sk_drag_data data=payload.view();
   int result=callback(window,phase,serial,p.x,p.y,effects(allowed),modifiers(keys),&data);
   if(effect)*effect=operation(result)&allowed;return S_OK;
 }
 public:explicit Target(int w):window(w){}
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,void** p) override {if(!p)return E_POINTER;*p=NULL;if(riid==IID_IUnknown||riid==IID_IDropTarget){*p=static_cast<IDropTarget*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
 ULONG STDMETHODCALLTYPE AddRef() override{return (ULONG)InterlockedIncrement(&refs);}
 ULONG STDMETHODCALLTYPE Release() override{LONG n=InterlockedDecrement(&refs);if(!n)delete this;return (ULONG)n;}
 HRESULT STDMETHODCALLTYPE DragEnter(IDataObject* obj,DWORD keys,POINTL p,DWORD* effect) override {serial=++sequence;payload=readPayload(obj);allowed=*effect;return dispatch(1,keys,p,effect);}
 HRESULT STDMETHODCALLTYPE DragOver(DWORD keys,POINTL p,DWORD* effect) override {allowed=*effect;return dispatch(2,keys,p,effect);}
 HRESULT STDMETHODCALLTYPE DragLeave() override {POINT p={};GetCursorPos(&p);dispatch(3,0,{p.x,p.y},NULL);payload=Payload();return S_OK;}
 HRESULT STDMETHODCALLTYPE Drop(IDataObject* obj,DWORD keys,POINTL p,DWORD* effect) override {payload=readPayload(obj);allowed=*effect;HRESULT hr=dispatch(4,keys,p,effect);payload=Payload();return hr;}
};
// Snapshot data is owned by this IDataObject until OLE and every recipient release it.
class Data:public IDataObject {
 LONG refs=1;std::vector<FORMATETC> formats;std::vector<std::vector<unsigned char>> bytes;
 void add(UINT format,const void* ptr,size_t n){formats.push_back({(CLIPFORMAT)format,NULL,DVASPECT_CONTENT,-1,TYMED_HGLOBAL});const unsigned char* p=(const unsigned char*)ptr;bytes.emplace_back(p,p+n);}
 public:explicit Data(const sk_drag_data* d){
   if(d->file_count){size_t count=1;std::vector<std::wstring> paths;for(int i=0;i<d->file_count;i++){paths.push_back(wide(d->files[i]));count+=paths.back().size()+1;}
    std::vector<unsigned char> b(sizeof(DROPFILES)+count*sizeof(wchar_t),0);DROPFILES* h=(DROPFILES*)b.data();h->pFiles=sizeof(DROPFILES);h->fWide=TRUE;wchar_t* p=(wchar_t*)(b.data()+sizeof(DROPFILES));for(auto& path:paths){memcpy(p,path.c_str(),(path.size()+1)*sizeof(wchar_t));p+=path.size()+1;}add(CF_HDROP,b.data(),b.size());}
   if(d->text){auto s=wide(d->text);add(CF_UNICODETEXT,s.c_str(),(s.size()+1)*sizeof(wchar_t));}
   if(d->url){auto s=wide(d->url);add(urlFormat,s.c_str(),(s.size()+1)*sizeof(wchar_t));}
 }
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,void** p) override{if(!p)return E_POINTER;*p=NULL;if(riid==IID_IUnknown||riid==IID_IDataObject){*p=static_cast<IDataObject*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
 ULONG STDMETHODCALLTYPE AddRef() override{return (ULONG)InterlockedIncrement(&refs);}
 ULONG STDMETHODCALLTYPE Release() override{LONG n=InterlockedDecrement(&refs);if(!n)delete this;return (ULONG)n;}
 HRESULT STDMETHODCALLTYPE GetData(FORMATETC* f,STGMEDIUM* out) override {
  if(!f||!out)return E_POINTER;
  for(size_t i=0;i<formats.size();i++)if(f->cfFormat==formats[i].cfFormat&&(f->tymed&TYMED_HGLOBAL)&&f->dwAspect==DVASPECT_CONTENT&&f->lindex==-1){
   HGLOBAL mem=GlobalAlloc(GMEM_MOVEABLE,bytes[i].size());if(!mem)return E_OUTOFMEMORY;void* p=GlobalLock(mem);if(!p){GlobalFree(mem);return E_OUTOFMEMORY;}memcpy(p,bytes[i].data(),bytes[i].size());GlobalUnlock(mem);out->tymed=TYMED_HGLOBAL;out->hGlobal=mem;out->pUnkForRelease=NULL;return S_OK;
  }return DV_E_FORMATETC;
 }
 HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* f) override{if(!f)return E_POINTER;for(auto& format:formats)if(format.cfFormat==f->cfFormat&&(f->tymed&TYMED_HGLOBAL)&&f->dwAspect==DVASPECT_CONTENT&&f->lindex==-1)return S_OK;return DV_E_FORMATETC;}
 HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*,STGMEDIUM*) override{return E_NOTIMPL;}
 HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*,FORMATETC* out) override{if(out)out->ptd=NULL;return E_NOTIMPL;}
 HRESULT STDMETHODCALLTYPE SetData(FORMATETC*,STGMEDIUM*,BOOL) override{return E_NOTIMPL;}
 HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction,IEnumFORMATETC** out) override {return direction==DATADIR_GET?SHCreateStdEnumFmtEtc((UINT)formats.size(),formats.data(),out):E_NOTIMPL;}
 HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*,DWORD,IAdviseSink*,DWORD*) override{return OLE_E_ADVISENOTSUPPORTED;}
 HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override{return OLE_E_ADVISENOTSUPPORTED;}
 HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override{return OLE_E_ADVISENOTSUPPORTED;}
};
class Source:public IDropSource {
 LONG refs=1;
 public:HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,void** p) override {if(!p)return E_POINTER;*p=NULL;if(riid==IID_IUnknown||riid==IID_IDropSource){*p=static_cast<IDropSource*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
 ULONG STDMETHODCALLTYPE AddRef() override{return (ULONG)InterlockedIncrement(&refs);}
 ULONG STDMETHODCALLTYPE Release() override{LONG n=InterlockedDecrement(&refs);if(!n)delete this;return (ULONG)n;}
 HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape,DWORD keys) override {
   if(escape||sourceWindow<0||!slots[sourceWindow].hwnd)return DRAGDROP_S_CANCEL;
   if(!(keys&MK_LBUTTON))return DRAGDROP_S_DROP;
   POINT p={};GetCursorPos(&p);p=logical(sourceWindow,p);if(callback)callback(sourceWindow,5,sourceSerial,p.x,p.y,sourceAllowed,modifiers(keys),NULL);return S_OK;
 }
 HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD effect) override {(void)effect;return DRAGDROP_S_USEDEFAULTCURSORS;}
};
static void shutdown(void){callback=NULL;for(int i=0;i<16;i++)sk_drag_detach(i);if(supported)OleUninitialize();supported=false;}
extern "C" void sk_drag_init(sk_drag_callback cb){callback=cb;supported=SUCCEEDED(OleInitialize(NULL));urlFormat=RegisterClipboardFormatW(L"UniformResourceLocatorW");if(supported)std::atexit(shutdown);}
extern "C" int sk_drag_supported(void){return supported?1:0;}
extern "C" int sk_drag_attach(int w,void* hwnd) {
 if(!supported||w<0||w>=16||!hwnd)return 0;if(slots[w].hwnd==(HWND)hwnd)return 1;sk_drag_detach(w);
 // SDL's default IDropTarget cannot provide synchronous AS3 acceptance. Replace
 // its registration, leaving the SDL window procedure and all input intact.
 RevokeDragDrop((HWND)hwnd);Target* t=new Target(w);HRESULT hr=RegisterDragDrop((HWND)hwnd,t);
 if(FAILED(hr)){t->Release();return 0;}slots[w]={(HWND)hwnd,t};return 1;
}
extern "C" void sk_drag_detach(int w){if(w<0||w>=16||!slots[w].hwnd)return;if(callback)callback(w,3,0,0,0,0,0,NULL);RevokeDragDrop(slots[w].hwnd);slots[w].target->Release();slots[w]={};}
extern "C" int sk_drag_begin(int w,uint64_t serial,const sk_drag_data* d,int allowed,const unsigned char* rgba,int width,int height,double dw,double dh,double ox,double oy) {
 if(!supported||w<0||w>=16||!slots[w].hwnd||!d||sourceData)return 0;
 Data* data=new Data(d);Source* source=new Source();sourceData=data;sourceWindow=w;sourceSerial=serial;sourceAllowed=allowed;
 // The helper's private clipboard formats require a fully mutable IDataObject;
 // this snapshot deliberately uses the system cursor until that protocol is added.
 (void)rgba;(void)width;(void)height;(void)dw;(void)dh;(void)ox;(void)oy;
 DWORD performed=0;HRESULT hr=DoDragDrop(data,source,operation(allowed),&performed);
 POINT p={};GetCursorPos(&p);if(slots[w].hwnd)p=logical(w,p);
 if(callback)callback(w,6,serial,p.x,p.y,hr==DRAGDROP_S_DROP?effects(performed):0,0,NULL);
 sourceData=NULL;sourceWindow=-1;source->Release();data->Release();return 1;
}
