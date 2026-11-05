// Shell dialogs own a dedicated STA; copied native values cross the thread
// boundary. Results are published once and consumed by the AS3 safe-point pump.
#define NOMINMAX
#include <windows.h>
#include <shobjidl.h>
#include <string>
#include <cstdio>
#include <vector>
#include <memory>
#include <mutex>
#include <thread>
#include "file_dialog.h"
struct Request {
  uint64_t serial; int mode,status=-1; HWND owner;
  std::wstring title,initial,name;
  std::vector<std::wstring> descriptions,extensions;
  std::vector<std::string> paths; std::string error;
  bool ready=false;
};
static std::mutex lock;
static std::shared_ptr<Request> active;
static std::wstring wide(const char* s) {
  if(!s||!*s)return {};int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,NULL,0);
  if(!n)return {};std::wstring r((size_t)n,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,&r[0],n);r.pop_back();return r;
}
static std::string utf8(const wchar_t* s) {
  if(!s)return {};int n=WideCharToMultiByte(CP_UTF8,0,s,-1,NULL,0,NULL,NULL);
  if(!n)return {};std::string r((size_t)n,'\0');WideCharToMultiByte(CP_UTF8,0,s,-1,&r[0],n,NULL,NULL);r.pop_back();return r;
}
static HRESULT appendPath(Request& r,IShellItem* item) {
  PWSTR path=NULL;HRESULT hr=item->GetDisplayName(SIGDN_FILESYSPATH,&path);
  if(SUCCEEDED(hr)) {r.paths.push_back(utf8(path));CoTaskMemFree(path);}return hr;
}
static void show(std::shared_ptr<Request> r) {
  HRESULT init=CoInitializeEx(NULL,COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE),hr=init;
  IFileDialog* dialog=NULL;
  if(SUCCEEDED(hr))hr=CoCreateInstance(r->mode==4?CLSID_FileSaveDialog:CLSID_FileOpenDialog,NULL,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dialog));
  if(SUCCEEDED(hr)) {
    DWORD flags=0;hr=dialog->GetOptions(&flags);
    flags|=FOS_FORCEFILESYSTEM|FOS_NOCHANGEDIR;
    if(r->mode==4)flags|=FOS_OVERWRITEPROMPT|FOS_PATHMUSTEXIST;
    else flags|=FOS_FILEMUSTEXIST|FOS_PATHMUSTEXIST;
    if(r->mode==2)flags|=FOS_ALLOWMULTISELECT;
    if(r->mode==3)flags|=FOS_PICKFOLDERS;
    if(SUCCEEDED(hr))hr=dialog->SetOptions(flags);
    if(!r->title.empty())dialog->SetTitle(r->title.c_str());
    if(!r->initial.empty()) {
      IShellItem* folder=NULL;
      if(SUCCEEDED(SHCreateItemFromParsingName(r->initial.c_str(),NULL,IID_PPV_ARGS(&folder)))) {dialog->SetFolder(folder);folder->Release();}
    }
    if(!r->name.empty())dialog->SetFileName(r->name.c_str());
    std::vector<COMDLG_FILTERSPEC> filters;
    for(size_t i=0;i<r->descriptions.size();i++)filters.push_back({r->descriptions[i].c_str(),r->extensions[i].c_str()});
    if(!filters.empty()&&r->mode!=3&&SUCCEEDED(hr))hr=dialog->SetFileTypes((UINT)filters.size(),filters.data());
    if(SUCCEEDED(hr))hr=dialog->Show(IsWindow(r->owner)?r->owner:NULL);
    if(SUCCEEDED(hr)) {
      if(r->mode==2) {
        IFileOpenDialog* open=NULL;IShellItemArray* items=NULL;
        hr=dialog->QueryInterface(IID_PPV_ARGS(&open));if(SUCCEEDED(hr))hr=open->GetResults(&items);
        DWORD count=0;if(SUCCEEDED(hr))hr=items->GetCount(&count);
        for(DWORD i=0;SUCCEEDED(hr)&&i<count;i++){IShellItem* item=NULL;hr=items->GetItemAt(i,&item);if(SUCCEEDED(hr)){hr=appendPath(*r,item);item->Release();}}
        if(items)items->Release();if(open)open->Release();
      } else {IShellItem* item=NULL;hr=dialog->GetResult(&item);if(SUCCEEDED(hr)){hr=appendPath(*r,item);item->Release();}}
    }
    dialog->Release();
  }
  r->status=SUCCEEDED(hr)?1:hr==HRESULT_FROM_WIN32(ERROR_CANCELLED)?0:-1;
  if(r->status!=1)r->paths.clear();
  if(r->status<0){char error[80];snprintf(error,sizeof(error),"Windows file dialog failed (HRESULT 0x%08lx)",(unsigned long)hr);r->error=error;}
  if(SUCCEEDED(init))CoUninitialize();
  std::lock_guard<std::mutex> guard(lock);r->ready=true;
}
extern "C" int sk_file_dialog_begin(uint64_t serial,int mode,const char* title,const char* initial,const char* name,int n,const char* const* descriptions,const char* const* extensions) {
  std::lock_guard<std::mutex> guard(lock);if(active)return 0;
  auto r=std::make_shared<Request>();r->serial=serial;r->mode=mode;r->owner=GetActiveWindow();r->title=wide(title);r->initial=wide(initial);r->name=wide(name);
  for(int i=0;i<n;i++){r->descriptions.push_back(wide(descriptions[i]));r->extensions.push_back(wide(extensions[i]));}
  active=r;
  try{std::thread(show,r).detach();}catch(...){active.reset();return 0;}return 1;
}
// AIR cancel() stops IO, not an open browse panel. No cross-STA COM call.
extern "C" void sk_file_dialog_cancel(uint64_t serial) {(void)serial;}
extern "C" int sk_file_dialog_poll(uint64_t* serial,int* status,int* count) {
  std::lock_guard<std::mutex> guard(lock);if(!active||!active->ready)return 0;
  *serial=active->serial;*status=active->status;*count=(int)active->paths.size();return 1;
}
extern "C" const char* sk_file_dialog_path(int i) {std::lock_guard<std::mutex> guard(lock);return active&&active->ready&&i>=0&&(size_t)i<active->paths.size()?active->paths[i].c_str():NULL;}
extern "C" const char* sk_file_dialog_error(void) {std::lock_guard<std::mutex> guard(lock);return active&&active->ready?active->error.c_str():"No file dialog result";}
extern "C" void sk_file_dialog_release(void) {std::lock_guard<std::mutex> guard(lock);if(active&&active->ready)active.reset();}
