#include "api/BitposClient.h"
#include <cassert>
#include <type_traits>
using Outcome=CardTransportPolicy::Outcome;
using Callback=Outcome (*)(const String&,const String&,const String&,const String&,String&);
using Send=Outcome (*)(const String&,long,const String&,const String&,String&);
using Cancel=Outcome (*)(const String&,String&);
using Create=String (*)(long,const String&,String&,String&,const String&);
static_assert(std::is_same<decltype(&BitposClient::submitLnurlCallback),Callback>::value,"exact callback API");
static_assert(std::is_same<decltype(&BitposClient::submitCardSend),Send>::value,"exact send API");
static_assert(std::is_same<decltype(&BitposClient::cancelWithdraw),Cancel>::value,"exact withdraw cancellation API");
static_assert(std::is_same<decltype(&BitposClient::cancelInvoice),Cancel>::value,"exact invoice cancellation API");
static_assert(std::is_same<decltype(&BitposClient::createWithdraw),Create>::value,"optional caller identity");
static_assert(std::is_same<decltype(BitposClient::LnurlWithdraw{}.maxWithdrawable),int64_t>::value,"64-bit limits");
static_assert(std::is_same<decltype(BitposClient::LnurlWithdraw{}.pinLimitMsats),int64_t>::value,"64-bit PIN limits");
static_assert(std::is_same<decltype(Invoice{}.ttlSec),uint32_t>::value,"bounded TTL type");
int main(){
    const Outcome outcomes[]={Outcome::NotSubmitted,Outcome::PinRejected,Outcome::Rejected,Outcome::Pending,Outcome::Paid,Outcome::Failed,Outcome::Expired,Outcome::Cancelled};
    for(unsigned i=0;i<8;i++)for(unsigned j=0;j<i;j++)assert(outcomes[i]!=outcomes[j]);
    Invoice invoice;assert(invoice.amountSats==0);assert(invoice.ttlSec==0);
    BitposClient::LnurlWithdraw card;assert(card.maxWithdrawable==0);assert(card.pinLimitMsats==-1);
}
