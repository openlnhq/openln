#pragma once
// Deterministic scheduler boundary; NOT a reimplementation of checkout logic.
// Keeps borrowed contexts busy through Ready, as the real worker contract does.
#include "Arduino.h"
#include <utility>
using BaseType_t=int;
using UBaseType_t=unsigned;
class RicIoWorker {
public:
    using Work=void(*)(void*);
    enum class Stage:uint32_t {Unavailable,Starting,Idle,Submitting,Queued,Running,Ready};
    inline static std::vector<RicIoWorker*> workers;
    inline static bool gateNetwork=false,gateNfc=false;
    inline static bool failNetworkBegin=false,failNfcBegin=false;
    unsigned starts=0,takes=0,rejections=0;
    RicIoWorker(){workers.push_back(this);}
    RicIoWorker(const RicIoWorker&)=delete;
    RicIoWorker& operator=(const RicIoWorker&)=delete;
    bool begin(const char* name="ric-io",uint32_t=16384,BaseType_t=0,UBaseType_t=1){
        name_=name;
        if(isNfc(*this)?failNfcBegin:failNetworkBegin){stage_=Stage::Unavailable;return false;}
        stage_=Stage::Idle;return true;
    }
    bool start(Work fn,void* ctx){if(!fn||stage_!=Stage::Idle){++rejections;return false;}fn_=fn;ctx_=ctx;started_=millis();stage_=Stage::Queued;++starts;return true;}
    bool busy()const{return stage_!=Stage::Idle && stage_!=Stage::Unavailable;}
    bool take(){if(stage_!=Stage::Ready)return false;stage_=Stage::Idle;++takes;return true;}
    Stage stage()const{return stage_;}
    uint32_t startedAt()const{return started_;}
    static bool isNfc(const RicIoWorker& w){return w.name_.find("nfc")!=std::string::npos;}
    static bool anyBusy(){for(auto* w:workers)if(w->busy())return true;return false;}
    static unsigned startCount(){unsigned n=0;for(auto* w:workers)n+=w->starts;return n;}
    static void pump(){
        for(auto* w:workers){
            if(w->stage_!=Stage::Queued && w->stage_!=Stage::Running)continue;
            w->stage_=Stage::Running;
            if(isNfc(*w)?gateNfc:gateNetwork)continue;
            RicMainShim::worker=w->name_;
            try{w->fn_(w->ctx_);}catch(...){RicMainShim::worker.clear();throw;}
            RicMainShim::worker.clear();w->stage_=Stage::Ready;
        }
    }
private:
    std::string name_; Stage stage_=Stage::Unavailable;
    Work fn_=nullptr;void* ctx_=nullptr;uint32_t started_=0;
};
