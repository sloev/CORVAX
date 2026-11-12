// CORVAX homepage app (served at /cx/app.js): DOX = a short introduction, APP = a live peer in this tab, STATS = numbers.
// Everything shown is real network state; nothing is mocked. State lives in localStorage ("corvax.*").
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAMAAAC8EZcfAAABIFBMVEUnGhoUGwsSFg1aLCcgHBTSph5hWlxmTiKYbCTu6J42TmS2jiAybJeWWV9pAgJbXALyjqCUNjLFZndGO0RHcpYMWw2Fj43MbYJOh69bXFunlmz/AAD5zyt0gH34ykQA/wAiKEZONSJLRS2BPkz////DRD3esUL//wAsQ0eqVVX/AP//f39MUDhZW00+QSU2bUgAmWYxg7l/AH+ZMzOqAFW/fz++bYeq/wD/qlX//8H3yAEAAAA9UoTle5IvNlMuJTP+1AM4R3NAVosoGil5h4bug5osK0hISEwyPGVUVVhueXlPJy4qFho7ToHXdYqMSFZlaGlINzbSpxA4MzesWms9PgFzOUathxNPNxfnug2KaBaGk5F0Vhi4ZHVnSBeXdRcVVRA7AAAAYHRSTlPtHV75nv79+/7/+v7+/gID/v3+//4J/v7+Bv4B//z/AfKzpP8B/P8BmgMBAmOZZg4F/wIFAwT/AwP//gD+/v7+/f7+/v/+/v7+/v7+/P7+/v7+/v7+Bf7++f7+/v7+//5QK1o7AAAcZElEQVR42s1dB2PayLYeEBIKxcFgxylOtt3d21+vBmaQBjUkkASYZsD//1+8c2YkmilyNrv3zW5C7BD4OPU7Z86MSfOr1+OVeMjl8vlCoUDIrCjWTCEEvs7nc+nzHpu/YpGvRSfB5RHY8nmqDofz+YNcc3WolqfPi+UMgEqYnx7f/q4A34LsvgNws/ViOpw/dMR62KxOsh7mw/LzUklAvn37ewF8K0RHiouyxPZwckmY6qJIJMivwfhqgFdCsbPF8OEctH2YD/PpciYxPv7GAAU8sixnRrcR5UMZMd6+GuJrJYi6Hb4O3QYkyJHkExv5TQBeNb8DeOpXwUswqs8z1PTVbwEQXheUO/x6eIk9PhOA+OmbAwTjyRV+jfS2GOcLVPTbbwvwqvm2QKYPvx6egKguSe6bSvARtbuYfxt4QtHDYiGXzRJJJvGBdoffDJ6A+KALh/5GEsyz5wzaPcx4F549XIMQc78eYK55W1hfFB9mtGG5DJxBnWcM4ujPGdR8WYL54Lj4NpQAHXO6jnE5DhIuTDRp/jgvxFn+V0vwvwuz4XF4w8V6vV48q+A7C2Wk9brdp27P87zejRZjsuk8DKfT86LvzJeF218H8LGwPC6+4Trgts045/56Nup13wM8zfGiXvfd09OTFg+nixn8LVtegIhqzn09wBx5PgrvYRnYhmmarVbL4EH09K7b7UZO9O7ps+fErOjEHOAb8AzDji8gLAPCx68DmAPzmx7FpyrEaMllEPb5CbTbc7zuUxQHQQBio65htEz5BLf4cNkQH78G4FUzf8L8VMLMVr8v8cUgvO77yOk99RinKW5Y/RY+w2ixaefXICSn5VeYHc8dc8LNjfycJwToOd0nj9NUailCg7ot0y12LmW+cwjJSfkViieC84xscJAY8T15jW435sYePMBHCQ+oaQSXomhnqJxGSE7Kb33i1RYb+2sxht7x1AM1M9ZqHeILKKWB0eLPF8P88LSnkNfiU1N8iKCHALsO4jNf4OOAj3LWshedhywIXwEQ/Pek7ym2mVoYiVDB75zoKeYH6u23XJQfpYy37GKGvFc+hZAcxzc79ULLFEq/xZkwwMh58oIX+jUkPtSxq8wzIJyS26vMEszP5qcUvHUFl/RQv9242wuMF/i4nQDkxmUvkR+9cNQMj0qQqKdecUZTfCZ3pAd7T0cMkDGaAqTmZS+Rr50/Vge8BHh1exJfZ0k2EFwu5Pe50Y3IoYJNSlJ8lNmmve5kIohHzZAcceBTH7jzzA10T6Fl7m0EuJVq8kiDkG9EyMAY5pkI4jP57u1FgJDgTkX+zjRw0bxYC2iAIQUIIcYjBwoGBxnX6j5PEYJBTrMR7fWReP0CYO6USXfKAcX4YVOTGaYtLPBdFO0IcGOdoTWw2pMUodGyZxmrvVnuhRmSFxlucQofmHsfFm9RyF88SmJ0L3hhgL7Vhv/GCk8BGlzNVgUciTWHEswppz5dgJJCDRscGAAD8b0DkvU0ss1DBQ+scNwOw4HPpSWC1JfZdNxZvvBkctD6K5SPv9Q8zSDUtu0WaLjbgxX1PhPjMMKE1mq1CsdWGBASJCJk2apWSKS5cxJ828yf+KgQYFICysGVW5QhN2VM85jZP6AICgAbW1ZI/NQMW1nyceLJhQMRkn0PIcc/aWeYJIs+sCd0FYMxJ/ICx+HGQQohgMsnZNUO/Jrlp1boKlnr5UM/IXsdjpMCXNgtAyRlmiDAvuACo6enzyPO3AMPYcqgVrPqPGyHq3CS+ImRPdIAa/ju6qQETwnwobN2Tanf2cwGfGD2o57nMOOQQ1PFqo0nyiQcWPX445s3mkwp2d1E+MnjcYAgwFM5CVmq4dp8NgU6iJhszmKo3Q5DoMHHtYn25k1NAx9+g0siBB3784wAh/uhZleCt0H55MdcEoKt6fsFkbUm1ulatE8D+6btW6EmgFWVj+LxTYC0xs3sx4CwuCdCsivA4rkmgCp6LkQIzYAw2O050QGNMXj9TgruzZs4edS4FCEvdzKLMPfpGMCrJjn7Gh0Z6tFrTTd+133X0zxCd53EpEptUk2BJRL8SEoy3elZG1/7Vki2Pd78ZWreWduiIGaQiSEPe2TEduKMCRaYCvDNx2oKEPDZhkmzA9wTIdnJwhcjQWdODEGX4+7T01M36o64tyk3IfRAEo73AFZrqR+b7jp7d3NXhFsV5y5Tjs4CvcIg3lPkeZ6GFTvzYrZJcpPaIAGo1WpFeCDaG0m7bLOf1Y1Fwtv2DclWgBmIuQLhELh+D7Jc7Dhx791Tw/EYbfUTGthuJyom1Y++Vv2ovfnoN2yh4+xeAquYa94eShAKkYufTAcBmgbz2MjBJRoeI2/EJEDqt9tWQ/pG9Y1WbYeKpgWaJmg1bZFF9vbwdJuRyTbGZBAgRVdl3IkizfMigPgUMU/mY9DwT1a7XZU6/t83/gBIYb0aahOfMZvZWVlrkpEPneTTySy3RycFjkBy1SiKYiBdDHQsAEIWAYB3MkJ/DCbwBUi0ZrUH41DhhEKozu4mzxs3SVWcyxBjZnRbr6ODRGCFCDAWVNFQBgjpv6oTTYsDfywApusujFlWvrAfaUhKVC/HGFUmNu4IAXbfAUDW6/IGkAYZpSWWwapaDauT9v6y2itfyb7X0oH66XZXgrnLlWFnLbJcP6lGwD8ij0VdNpJGaNphIrP6arCa3CGmu8GOGC2r6j9nDtblQhJpSJJFlpc9K2EGTHY8EGCEABMvMdkK0dTD+uAuVAaWNZ5MgHXtSXHgrzPvp812neQxSxBU6AFALerF0RNPABq+RAFsUAlBXBNldTee+PU9hFboq53XuYkA+Om7iz4MjDDtWm4Aar04jkDFHnfBBKXbti35ywfCD4/jn+72TXHsZ8vJnWESCkm2NLcpSnYBej0PEMYSIAt33XbiV5MvBwfOMsiIMNUxyRalgcak1I9FT4kXez0sjUGCCJ6vtgAtML9x+/iy2o1M7B956xbgpSDTKaesCliztgXY6z5FqGKsiraiqoV+W7ixWC8QWpN1pnQnjZBkM0Fl28GSXRkRqHHjy4uFk7j+TjhR7tqTVQ0ySBhWV0eEOJlloTTSCKUNzuYZaFYC0I0TgFAYgzkiZ+Cmaac+Yq18SMPtMVTHilataoD0hRDbSgYZzpVtmMmft4odD5EFk0SoRR6E7NjxRrZpsiS13U0UaX1344FVq9UGVRDjeFwf7CtbyWCHxVwCEHzkQhSc7TWIKAPJfe4BZwUB9kaOFwBLZDJpjJUxFMZjIUoLo4oSjsOfAs79SbjaBXk5qXQWwggFwML5aun5YJOBBSPGgLH2cA8CMx2QxNiSMeQO6/Zt7FPQty0fOKvNmK+E9W20uRh5pynAT83zPqIGB5tcBoRCrIvfdZ+QzARAcqiIglY1BA8GkNt4OBBOIfvB8KkCvzqw5FMvb+EJLyEiTM/PljCHTXzgrBFUIw0o7AAfQS4jTdCqrqxJu65sOcJPAmDI0n66G8z8UKo6Hl6kXM0/IsCr81xw30MShAbIwonZCPTMbSFToVWrvkLjG/v1FGFV5jcJ0ObYa1UX/mQ8aF/W8XwmneTt+TzSWR62UEU732COQ4DLy5Z/yhRkYgOEYaLIcVW4Ck83dUx7cY8jGL6vLLO5MbnkxPNDC0wggvCYabTEWACQVWs/4YbKBEILEC+0TWu1BejORJNirl7m/1geS4DnEh0UIsfwQUJhMdtml/AgGFt34xDoYCijYypB5pppZZJhtkbGGXKmL31SwzJeo/emgWd8JOVuM3EK0KamybO3QJ4lwKsmOUciZ8bhPlLCGhxn8zcGqx8BWKsnUW+jYhu71cvX0P5HEWbOhUGVGa2jAI3GDkB/cIhvMF6Fk+S7VjXZF2MYMTOXxzsA52eiJWsdBWi6zlbDxwBCCh5s2MsOQPcbA5wmniCneHYBerSVfm/LtfZscAPW32zNwnOV+asBKg+XAb5YCNBwpZaPAdytQ/hmc7v1ig0JmYy/FqAJNmiLPr/oa9XPIfTTrVnef5UNbgDOHjLZ4MGyIdc1IioBhtZpfON0fIHja9nr1wMk5xIiM07oGJJdwxlJCXIliwCJqO8Xr42DZ53k4WFNTwFswBtL9H2bjU9aYMi30wutlpZxZ3YH4Hk62Jny0iFRSIi1Q03wEvln6l/ERzAlZZxf2KS6tzLVnf1Qs3036See24JASB1HWoBL7eNWaFU3+Ljos5Ph1wA8VxUDH9zPxq5tG3K0zWPMi+TGjq35Rx053HUQ3B/YT/tnx4axdH8r2czZ/N1Rg51NQwjYQKiZC99wG15Da+C+BPAt90gstOp+Mp5iy10995Ap4JTr6Xdebvjg4kLVOePJQKhhUNtmUP9wTg2jQRu2nXgMbbGwtp9J7iZB4r9iDxzsj+ypqjMvliqVUvFkRy4hrFCTXCC3nYfpGipHzgPCgUIbhlAq6FczaGNDJszEk5P21ipUiByP4sJGgAmuD2zdq8D614ozP9c+EoX7xf40jhw/F0lAd1VNnQbwfsfekq5xDWnMuA5Exk8nexhh8gP503176xQrlWJZxd87G4vcpbJzsgGYIX93OrpiH1RPtocItwZq+FAF3/3kKxyLlQSe0K7BXpxV6KgtQAZoiokIO53hs77UF4tp8sy0qkM3vrwFAXZoHMklIEThAbI0MThquTZJJ99sjp1DhEfWh+4KAiwhks60UhoKwEuQJ66yLkbfsS7O1lkQQT04klAMh9mAxTA4txEIhhHg/taEpL6ByF1Usstn04Mc6lWES3eGlQrYZmc6E9AWul6Gx6na2XYWLvZmOg9rfiwju6BfJ/YABYQ5RsVGKKtaVpUk8AwxhCH+LTxlr4HeGZYqU7kFjQA7i/V9eTlFXavTha4WizrGaWmDtxfcuDOf8aPZuG9HDcY03B9zbdAnhBxTYxNrgNkDfQN0zt0k85imvWvqW4ALUPG9XrxfPksvgV9TvVzW9KI4+UQu7pJ0hsQ+xQmp52m2LN0h/tiY93BuAXRMkIdh/qXb1ifbabF01JJUMTiJ1ykr90U0s+EC1vThflr++FEjafsNt2JPZ+NkaOs4QhpjqSYyHxAGw7XFbqNfZaDWfovilNzuh+PrPRsU4WVoVIoPiqqDODtgf7iWqqpXP1YlwqSJfjKX4FDeKXwAKmIQr2WshtxHBbsBuxMUwoAy3d77x8ZOqgMv9sAoO88VQ12WVQSwKKv6s/5cVpcP5aIOCFOAt6fbR4DPPY0PYjUSBntLxMxE9SJkmmnNslnadpy1M2210AhBkOpaXaMxFvUFmiHI8LmjFrXq35ofNvskp2a2yoFxGp+YRQdPPiJi1z3BcrdbnvMi6LajVlrThaqXMZ3qsXSb5/ICR6T+adtEP8W4LuID1sr4qEHPP2nPr3hqTZ1FCyK0VtHmC3W2WMdKWVfmMjLq+nCz6U7OTJV1VOKef2sTs10cNYzMCEGGaUwDP556hlFcl3XmeFTXdSZD5VwvD4EM/vnt7nbssSarGiTjEmfejuFgAGu9Zkk7hHCnlWIITZSpRRqPuK4uqSNDJQDc3+08Tvtx+0uOcxiSYh2t38EI6SsEKA6hzMVZ3kXMaAkielFlJZCgsmb0s6yaIdule4kJwGOBRuywQ6BgPIBEJpdNjUObchqGS+kr4Ll9NofMGzeoM6oYJcaKxVFpNHI8DUdOxfkdXVcX6dACOTnW01mCAVJu24SWDLlc5Cd7pMvEfNzwRkZWH4EQbhQ7ZaZ1PebQUqXESgEZOQjOi0dOxMoS4Oxw6uO7F03CeSxmps2DIUGD7mE0mAav23AzKdnE2rgEhZOiOYDF0YBtg+iiSHNGo5EX3XS1GaLQ9UU6EbAzN3Oo4yGYPtCRI1EOxLDtGlIwwtjOBK/FuHaDcUbnXQ3gMQTXi5wRQxF2e5rWpVMJkLwYSzmiY4XgRvqx5hGkCi4KO4F2xDLJD4ihzUyqAAQFh5xHXi+KvEYcO1Gvq2kAlzk9RUwB6mVy+3J262UjeBFwOzhlXcj30k6rQS/bYB8JhM2B+UN47fV6nyPNA9fQxJFBUAmoeBQ5Mhzr5e34GzkzAQyh4BTT2kA0jQak45gZl8TH4ZX6ItN1lhSnxLveqAfgPDA/6tDGyKGsJ88RdPTyj80/vxzPe5mPOzo5n+gYGD0yGs85q2XhvNIgAMI8iMQYOwM1Q+iiuOM8ctioETkzMejZWev6ZvyNbEdYj4ymKO7lsAHwPI+edQ4asLTyg0g85d0uCtDpslEJp+hKdOT08HgtV/Q12MAwKP7yQzr+tjMF/CLddXR22foB4giLo9NPsAOo7VqpmdqLoud43V53FEVMc0ogRAh/OLPb1cj19bWiqMt8rlzO72WS45RmrmTJYX0aQUFyNBdCxQmRHafVkV4n3XgWoE1AnOlCoIYIg0d+hcq7DAiNDhCBSRfUYvN/XgA8oK27kwpnOSG8oQMVOoLclSROhgdsk6iTutq0Y4/RUXfkdGWEkegAXxT4+n1ncX1daP45VwQRXh2o+FCEc+Jmir8uhAePIRpxfsTdJEWQ3Y4KKE9Ghb1RiXm9oIeG2P2coIMvWDhAJ1eqPzT/vZkv6z8+HgA8YP5nBdg39mj1SBYhiAsPbSM25BV7lmmIkAqRXwO/6jqjbu9zgg3QeXEc+xNrPAMXvlZyzU+PRV1PC/ddEe448lw5FzogHRsbIwSdsUNpv3QbBuyt3yJAzxg4sAw1CE7zPDZZDeSWz7wMnpLHgctikeT+eHAa4tPOpK2YqD0D0Dbd9AMwLWAZSKshZpwDDH69qAH4PgM4TMQ0GNckwLZSnuWvQXT/2QQJilngFydytt25s5WGwYHXpLENYpl2CaBpGsR2Dbtxgy4CKQ68QqAreUyzJlUNEQ6Ky0JTuUbd5lW1mG5D7J1KTJScDoSeJu7wZukz7NhhlxyKcn8y8X2wPw6kwAH7646oCNNOMB5rtXBsDWpVZZYTAHOgY/1Ja/7h5akwkuyI6/aFes7eAITyeMMWTNM8PkHgj61azRrc1eurMGZIZzTmyEXGd5NadVWzxvEMsKEN5j40C0/vfnwJ8Co9cnAxSBt8o+KWrdF+SmfF0Ycj+NpWOpBkWe2xD07iCAE6LODKSplMxtWJvy40m3ldEW2txx/yx87VJSl5M7F6Jj5v2xoUTNAWlIVi2/kF+wIWOGhPJqu9/QmNYiL2mI+a5YGPwyok91cEmDt3+PRKHN7dGWg8WRLvNEUg8PK+aTMER41KJYmB5oZrDWrjyf5gyDiQFuhb49Bq1+9wcL0dA4Af6nLsrfnhw4nzxbnZUJzLuFg9bocFbGD9pk3fG5DZDAo4ad818BYDA9tJbrCywPpwqGazyw1i4yjAUbgKq8ku1aDtY8P8572jdeToBRAP0wxpeKdpbWsMyoD31E4M8T0Uk1j1ljCp2AE4qIQ2CMfJVry10hSgkQCwOrDkcMOgXQcTbF7rJ8407Z0Om11ut+yWU9Sjhl0pJWYBzF6/V9elG+wdmhqpWmKCawC/1yfKpFq3sJE9qBIwQhr4g0EoRvlqAz/3F+nElw/hBxkK3Z16yhhFjL63Nw2islok7g3O8dg2lzM11ngiZs7AgeOwZq0mtQGhTomHse+HgwFOKTG8OOXAR44fwgdXzkJV+d72u1EBAQIDpDYpq/x79h4JBFCHVYIvlPZnWWHD8euWUg2DkjMCH/Eniu/7sa/92Lx6zAYwI8LUCNFh2agC/oAkixH9nhi8UsLuPwGxyYGz8M7abNHGHg/r1QkDE1TGq7sQtH83sKwfEoBZrtK4ui3YFxHaNIkitu3SoEIDvGTGdOP7tUtLFXAzA9wjnfSub0ZrBlYY90bcB3yg4knNChPcwPIzA2w2/5lc5CeuMDrz+xkQD0ZukhTCVfV7g7wHPmbaYW1wMEwjH3wtAhcfscbIx+HWGnx/EGK3Q6r4KgPA2+YtuVTsymRMlqquMJvdiBPcpl384vdto4JX0vCDTW5rNU7GCrHMpFCNgAtPAGIIPKJw+0lc8XV9fSnMbEoUdgYhegPOA5pEVwPRI7kRcPvsHmgGqeA2Dp6z285KiQkVX5GHOmJRZna9SS0Mx6tqWF390PyroKRNpU7yf8xyY0/uDEKIymJDk1F7dj/DlGfQChVDE/oX1ndpheGft0N7KLu2HB/FtFGPZamk+dUBBBzLqq3yV7mE1SvXfi7jnUe3o+NTMwAPt+DxvDtRJS+jRskVAvyi2zf2Dbjw3sgZjt8mw5l42iQUR+TxopBgtYK4Dd+FGJ3cAnD9syCEGW6Nygk7NI9EaCQDLdz5spcql60hJAiJAFv0hokprZ3zEatVmm/vgvpdkJRKI2Cvymo11gpbmSk/X+uF5n9kutYKEXL3RStB9BEMbgM35ar+PYTnPpTurnThsn1DhYsczI0OtjxGYZpABzGTl0r5fCG/hffX5g8/Y2V8le3erQ/N20JAD/CJ3VVXdIPc2RcfZcVKFUFZ3eJ9bJhMZmW2OhxsTaf1tB7SVKihR6zypxdE4NqP/r7lM1nuftt1FQPiW99AfCJU66qN/lyqGCwRIDEN9h6PHb+YehyME0rjM0Y4pSXKSOkGYkpu90z7h1xBe/cZuH5WgBBudgMi3hVAzaRL0CJldBF68x6Ii4k3WH2BSsEFtnUYZISfKD7O8lsDzlyb4eR8IVcqbY+ZbkJw8enzkcOnZ65v/Jd9NQMLTWkCV4suZLpWpVLCrWL2C1qkXZJBJrR21IoXQ1wrONZam+AWLqM8yDfzN6UjZvWjln/tHZi5wrashIpjc36IAUCoSBqgLunC+Dd2pWLjjQtIUwfJeLB15xPlWoz+/MRNqAh5gNcjQrq7dG9sJoBXeAdmqmc5u5U4jFo0+qMowt060/C/FHFvCqIgHjRnEN8GIZEFeUi4ca1gUvMJHoBi4oLJP91USvnm7THnfO0top+auXwgycBO3yiRYKTh3EKf/6KLqXX7xqBivH8QIvniQPYCopScax8Hq9xWH5wj/x1UZ82Cgzb4zW6yzRWCw3qSqborimG85EP9hYjqGAAKJw65nI2yXddVrkuTayaqeoQnUP2hqfW00je9yfYAIlAXDDOmvAOkfC/q0H4KkBAmhs9xt8q+9lvKtYhIKTx0V6cKTvKHb3kX8AZi2kjwIfVibclj9QuhuDkqbBAnznky220rrq1c05aiQGHFxYXKmzPNPe1Ply4Sfd1tygIiuEuK0aTF+zJUPcXyFxX8XN5JSEs3tkjYEiC/vr6uKi1DUUiwk3IxwGrRKLfrEN/iumd5XzbbaNouqvdfvnxRdWakN+O4pfd4M0UKkPjX14r9HqJg4eAe5dzf/p67eCfw668czzWlGKls7LusqOsxs1ubm3ugbi+lAG1kEZyTm1JBUX6/S9uvEowIEgwfvLQv2LRYgO0GyKsEiAfBggIpvSc5X8kfXgub+/CbXXv/mF56j5e8GZq5N9tgoI5BuQzSBV7Pn4Ov84pyrfxuEtyoGkHmCwiTba+jA7nd3DBxJ794Tr70vpQHAf7eAJs7d8Tn8McbiB9wIH6mQZ68LxU24R3xAZOv1v8BACWElxcbglIrBelNpZubEeTdPG5xNf/yDwGYgnp8zOF6xBZQDnCVvi98b9zcGOJW53wx9grND/9IgAcLRQerVJAX3X+IvHeFZu7/EUDQakH+7IoP+H/eqwIN/f8kwQ/7jznv3Y/Nf/uK1/k/+BR4as+SKi0AAAAASUVORK5CYII='

// ---- tiny DOM + storage helpers ---------------------------------------------------------------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) if (v === false || v == null) continue; else k.startsWith('on') ? el.addEventListener(k.slice(2), v) : el.setAttribute(k, v === true ? '' : v)
  el.append(...kids.flat().filter(k => k != null && k !== false))
  return el
}
const store = {
  get (k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set (k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
  clear () { try { for (const k of Object.keys(localStorage)) if (k.startsWith('corvax.')) localStorage.removeItem(k) } catch {} }
}
const node = document.body.dataset, anchors = document.getElementById('anchors')
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0} min` : s < 86400 ? `${s / 3600 | 0} h` : `${s / 86400 | 0} d` }
const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`) } catch { toast('Copy failed', true) } }

// ---- state ------------------------------------------------------------------------------------
const old = store.get('corvax.app', {})
const app = {
  live: !!old.live, name: old.name || '', contacts: old.contacts || {}, follows: old.follows || [],
  topics: Array.isArray(old.topics) ? old.topics : Object.keys(old.topics || {})          // migrate the older format
}
const save = () => store.set('corvax.app', app)
const msgs = store.get('corvax.msgs', {})                                                   // address -> [{ me, text, at }]
const feed = []                                                                             // live updates only (no history)
const seen = new Map()                                                                      // address -> last time heard from
const chans = new Map()                                                                     // address -> open DataChannel
const ui = { view: store.get('corvax.view', 'app'), tab: 'home', peer: null, chat: null, status: 'offline', found: null }
let me
const nameOf = a => a === me?.address ? 'You' : app.contacts[a]?.name || short(a)
const ownTopic = a => `@${a}`

// Presence, from real signals only: an open channel, a live lease on a topic we watch, or a recent message.
function presence (a) {
  if (chans.get(a)?.readyState === 'open') return 'connected'
  const lease = [...me?.topics.handles.values() || []].some(t => t.providers.get(a)?.presence === 'recent')
  return lease || Date.now() - (seen.get(a) || 0) < 10 * 60e3 ? 'recent' : 'unseen'
}
const LABEL = { connected: 'Connected', recent: 'Seen recently', unseen: 'Not seen' }
const dot = p => h('span', { class: `dot ${p}`, title: LABEL[p] })

// ---- layout -----------------------------------------------------------------------------------
document.head.append(h('style', {}, `
:root{--fg:#17181c;--bg:#fcfbf8;--mute:#6b6e78;--line:#e7e4dc;--soft:#f3f1ea;--accent:#2f4b9a;--on:#fff;--ok:#2e9d5b;--warn:#c9922b;--bad:#c4473a}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe7;--bg:#121317;--mute:#9a9ca6;--line:#2a2c33;--soft:#1b1d22;--accent:#8ea8ff;--on:#0e1220}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0 auto;max-width:40rem;padding:1.25rem 1rem 4rem;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:.9rem;margin-bottom:1.4rem}
header img{width:80px;height:80px}
header b{font-size:1.5rem;letter-spacing:.08em;flex:1}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:3px}
.seg button{border:0;background:none;padding:.35rem .9rem;border-radius:999px;font-weight:600;color:var(--mute)}
.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
nav{display:flex;border-bottom:1px solid var(--line);margin:1rem 0}
nav button{flex:1;border:0;background:none;padding:.6rem .1rem;font-size:.92rem;color:var(--mute);border-bottom:2px solid transparent;white-space:nowrap}
nav button[aria-current=page]{color:var(--fg);border-color:var(--fg)}
button{font:inherit;color:inherit;cursor:pointer}
button:disabled{opacity:.45;cursor:default}
.btn{border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:.55rem 1rem}
.btn:hover:not(:disabled){background:var(--soft)}
.primary{background:var(--accent);border-color:var(--accent);color:var(--on)}.primary:hover:not(:disabled){background:var(--accent);filter:brightness(1.08)}
input{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:.55rem .75rem;min-width:0;flex:1}
input:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.row{display:flex;gap:.5rem;align-items:center;margin:.6rem 0}
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;align-items:center;gap:.75rem;padding:.7rem .25rem;border-bottom:1px solid var(--line)}
.list li[role=button]{cursor:pointer}.list li[role=button]:hover{background:var(--soft)}
.list .main{flex:1;min-width:0}.list .sub{color:var(--mute);font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:.6rem;height:.6rem;border-radius:50%;flex:none;border:2px solid var(--mute)}
.dot.connected,.dot.online{background:var(--ok);border-color:var(--ok)}.dot.recent,.dot.connecting{background:var(--warn);border-color:var(--warn)}.dot.offline.bad{border-color:var(--bad)}
.mute{color:var(--mute)}.small{font-size:.88rem}h2{font-size:1.1rem;margin:1.6rem 0 .4rem}h3{font-size:1rem;margin:1.2rem 0 .3rem}
.empty{color:var(--mute);text-align:center;padding:2rem 1rem}
.me{display:flex;align-items:center;gap:.75rem}.me .main{flex:1;min-width:0}
code{font:13px/1.5 ui-monospace,monospace;word-break:break-all}
pre{font:13px/1.5 ui-monospace,monospace;background:var(--soft);border-radius:10px;padding:.75rem;overflow-x:auto}
.bubbles{display:flex;flex-direction:column;gap:.35rem;margin:1rem 0;max-height:55vh;overflow-y:auto}
.bubble{max-width:80%;padding:.45rem .75rem;border-radius:14px;background:var(--soft);align-self:flex-start;word-break:break-word}
.bubble.mine{align-self:flex-end;background:var(--accent);color:var(--on)}
.back{border:0;background:none;color:var(--accent);padding:0;margin:.5rem 0}
#toast{position:fixed;left:50%;bottom:1.2rem;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:.5rem 1rem;border-radius:10px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.show{opacity:1}#toast.bad{background:var(--bad);color:#fff}
details summary{cursor:pointer;color:var(--mute)}
@media (max-width:480px){header{gap:.6rem}header img{width:64px;height:64px}header b{font-size:1.2rem}.seg button{padding:.3rem .6rem;font-size:.85rem}}
@media (max-width:360px){header b{visibility:hidden;width:0}nav button{font-size:.78rem;min-width:0;overflow:hidden;text-overflow:ellipsis}}
`))
const main = h('main')
const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' })
document.body.prepend(h('header', {}, h('img', { src: LOGO, alt: '' }), h('b', {}, 'CORVAX'), seg), main, h('div', { id: 'toast', role: 'status' }))
anchors.hidden = true
let toastTimer
function toast (text, bad = false) {
  const t = document.getElementById('toast')
  t.textContent = text; t.className = `show${bad ? ' bad' : ''}`
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = '' }, 2200)
}
const attempt = fn => async (...args) => { try { await fn(...args) } catch (e) { toast(e.code ? `${e.code}: ${e.message}` : e.message || 'Failed', true) } finally { render() } }

let renderQueued = false
function render () {
  if (renderQueued) return
  renderQueued = true
  queueMicrotask(() => {
    renderQueued = false
    const focus = document.activeElement?.dataset?.keep, value = focus && document.activeElement.value
    seg.replaceChildren(...['dox', 'app', 'stats'].map(v => h('button', { 'aria-pressed': String(ui.view === v), onclick: () => { ui.view = v; store.set('corvax.view', v); render() } }, v.toUpperCase())))
    main.replaceChildren(ui.view === 'dox' ? dox() : ui.view === 'stats' ? stats() : me ? appView() : start())
    if (focus) { const el = main.querySelector(`[data-keep="${focus}"]`); if (el) { el.value = value; el.focus() } }
  })
}

// ---- going online -------------------------------------------------------------------------------
function start () {
  const has = (() => { try { return !!localStorage.getItem('corvax.seed') } catch { return false } })()
  return h('section', { class: 'empty' },
    h('p', {}, has ? 'Your identity is stored in this browser.' : 'Create an identity to join the network.'),
    h('button', { class: 'btn primary', disabled: ui.status === 'connecting', onclick: online }, ui.status === 'connecting' ? 'Connecting…' : has ? 'Go online' : 'Create identity'),
    ui.status === 'error' && h('p', { class: 'small mute' }, 'Could not reach the network. Try again.'))
}
async function online () {
  ui.status = 'connecting'; render()
  try {
    const { Peer } = await import('./index.js')
    let seed = null
    try { seed = localStorage.getItem('corvax.seed') } catch {}
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(location.hostname)
    me = window.corvax = await Peer.create({ seed, allowPrivate: local })
    try { localStorage.setItem('corvax.seed', me.seed) } catch {}
    await me.publish(app.name ? { n: app.name } : {})
    app.live = true; save()
    ui.status = 'online'
    wire()
    toast('You are online')
    if (invite) { try { ui.peer = addContact(invite); ui.tab = 'peers' } catch {} history.replaceState(null, '', location.pathname) }
  } catch (e) { ui.status = 'error'; me = null; toast(e.message || 'Could not go online', true) }
  render()
}

// Connect the peer's events to the UI, and restore what this browser had joined.
function wire () {
  me.on(({ from, body }) => incoming(from, typeof body === 'string' ? body : body?.text ?? JSON.stringify(body)))
  me.accept(({ from, channel }) => attachChannel(from, channel))
  join(ownTopic(me.address), true)                                      // you are present on your own topic: followers see you
  for (const t of app.topics) join(t)
  for (const a of app.follows) join(ownTopic(a))
  setInterval(render, 15e3)                                             // presence and "ago" labels age
}
const unsubs = new Map()                                                // topic name -> unsubscribe
async function join (name, own = false) {
  const t = await me.topic(name)
  if (!unsubs.has(t.name)) {
    unsubs.set(t.name, t.subscribe({
      presence: e => { if (!own) seen.set(e.address, e.presence === 'recent' ? Date.now() : seen.get(e.address) || 0); render() },
      message: m => {
        seen.set(m.from, Date.now())
        const text = JSON.stringify(m.body)                               // one update can reach us via several topics
        if (feed.some(u => u.from === m.from && JSON.stringify(u.body) === text && Date.now() - u.at < 10e3)) return
        feed.unshift({ ...m, at: Date.now() }); feed.length = Math.min(feed.length, 100); render()
      }
    }))
  }
  if (!t.published) await t.publish().catch(e => toast(`${name}: ${e.message}`, true))
  return t
}
async function leave (name) {
  const t = await me.topic(name)
  unsubs.get(t.name)?.(); unsubs.delete(t.name)
  await t.unpublish()
}
function incoming (from, text) {
  seen.set(from, Date.now())
  if (!app.contacts[from]) { app.contacts[from] = { name: '' }; save(); nameLookup(from) }
  addMsg(from, { me: false, text })
  if (ui.chat !== from) toast(`Message from ${nameOf(from)}`)
  render()
}
function addMsg (a, m) { (msgs[a] ||= []).push({ ...m, at: Date.now() }); msgs[a] = msgs[a].slice(-200); store.set('corvax.msgs', msgs) }
function attachChannel (a, ch) {
  chans.set(a, ch)
  ch.onmessage = e => incoming(a, String(e.data))
  ch.onclose = () => { chans.delete(a); render() }
  render()
}
async function nameLookup (a) {
  const b = await me.resolve(a).catch(() => null)
  const n = b?.fields?.n?.[0]
  if (n && app.contacts[a] && !app.contacts[a].name) { app.contacts[a].name = n.slice(0, 40); save(); render() }
}
function addContact (a, name = '') {
  a = a.trim().toLowerCase().replace(/^.*#peer=/, '')
  if (!/^[a-z0-9]{52}$/.test(a)) throw new Error('That is not a CORVAX address')
  if (a === me.address) throw new Error('That is you')
  app.contacts[a] ||= { name }; save(); nameLookup(a)
  return a
}

// ---- APP --------------------------------------------------------------------------------------
const TABS = [['home', 'Home'], ['peers', 'Peers'], ['discover', 'Discover'], ['updates', 'Updates'], ['messages', 'Messages']]
function appView () {
  const go = t => () => { ui.tab = t; ui.peer = ui.chat = null; render() }
  return h('div', {},
    h('nav', { 'aria-label': 'Sections' }, TABS.map(([id, label]) => h('button', { 'aria-current': ui.tab === id ? 'page' : false, onclick: go(id) }, label))),
    ui.chat ? chat(ui.chat) : ui.peer ? peerView(ui.peer) : { home, peers, discover, updates, messages }[ui.tab]())
}

function home () {
  const contacts = Object.keys(app.contacts), around = contacts.filter(a => presence(a) !== 'unseen')
  const link = `${location.origin}/#peer=${me.address}`
  const name = h('input', { placeholder: 'Your name (optional)', value: app.name, 'data-keep': 'name', 'aria-label': 'Your name' })
  return h('section', {},
    h('div', { class: 'me' }, h('span', { class: 'dot online', title: 'Online' }), h('div', { class: 'main' }, h('b', {}, app.name || 'You'), h('div', { class: 'small mute' }, h('code', {}, short(me.address)), ' · online'))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => copy(me.address, 'Address') }, 'Copy address'), h('button', { class: 'btn', onclick: () => copy(link, 'Link') }, 'Copy invite link')),
    h('div', { class: 'row' }, name, h('button', { class: 'btn', onclick: attempt(async () => { app.name = name.value.trim().slice(0, 40); save(); await me.publish(app.name ? { n: app.name } : {}); toast('Name saved') }) }, 'Save')),
    h('h2', {}, 'Around you'),
    around.length ? peerList(around) : h('p', { class: 'mute small' }, contacts.length ? 'None of your peers have been seen recently.' : 'No peers yet. Share your invite link or add someone in Peers.'),
    contacts.length + app.topics.length > 0 && h('p', { class: 'small mute' }, `${contacts.length} peers · ${app.topics.length} topics · ${app.follows.length} following`))
}

function peerList (list) {
  return h('ul', { class: 'list' }, list.map(a => {
    const p = presence(a)
    return h('li', { role: 'button', tabindex: 0, onclick: () => { ui.peer = a; render() }, onkeydown: e => e.key === 'Enter' && e.currentTarget.click() },
      dot(p), h('div', { class: 'main' }, h('div', {}, nameOf(a)), h('div', { class: 'sub' }, `${LABEL[p]}${app.follows.includes(a) ? ' · Following' : ''}`)))
  }))
}

function peers () {
  const input = h('input', { placeholder: 'Address or invite link', 'data-keep': 'add', 'aria-label': 'Peer address' })
  const list = Object.keys(app.contacts).sort((x, y) => ['connected', 'recent', 'unseen'].indexOf(presence(x)) - ['connected', 'recent', 'unseen'].indexOf(presence(y)))
  return h('section', {},
    h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onclick: attempt(() => { ui.peer = addContact(input.value); toast('Peer added') }) }, 'Add')),
    list.length ? peerList(list) : h('p', { class: 'empty' }, 'Add a peer by their address, or share your invite link from Home.'))
}

function peerView (a) {
  const c = app.contacts[a] || { name: '' }, p = presence(a), following = app.follows.includes(a)
  const name = h('input', { value: c.name, placeholder: short(a), 'data-keep': 'pname', 'aria-label': 'Name' })
  return h('section', {},
    h('button', { class: 'back', onclick: () => { ui.peer = null; render() } }, '← Peers'),
    h('div', { class: 'me' }, dot(p), h('div', { class: 'main' }, h('b', {}, nameOf(a)), h('div', { class: 'small mute' }, LABEL[p]))),
    h('div', { class: 'row' }, h('code', { class: 'small mute', style: 'flex:1' }, a), h('button', { class: 'btn', onclick: () => copy(a, 'Address') }, 'Copy')),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => { ui.chat = a; ui.peer = null; render() } }, 'Message'),
      h('button', { class: 'btn', disabled: p === 'connected', onclick: attempt(async () => { toast('Connecting…'); const r = await me.connect(a); attachChannel(a, r.channel); toast(r.kind === 'direct' ? 'Connected directly' : 'Connected via another peer') }) }, p === 'connected' ? 'Connected' : 'Connect'),
      h('button', { class: 'btn', onclick: attempt(async () => {
        if (following) { app.follows = app.follows.filter(x => x !== a); save(); await leave(ownTopic(a)); return toast('Unfollowed') }
        app.follows.push(a); save(); await join(ownTopic(a)); toast('Following')
      }) }, following ? 'Unfollow' : 'Follow')),
    h('div', { class: 'row' }, name, h('button', { class: 'btn', onclick: () => { app.contacts[a] = { ...c, name: name.value.trim().slice(0, 40) }; save(); toast('Saved'); render() } }, 'Rename')),
    h('button', { class: 'back', style: 'color:var(--bad)', onclick: () => { delete app.contacts[a]; app.follows = app.follows.filter(x => x !== a); save(); ui.peer = null; toast('Removed'); render() } }, 'Remove peer'))
}

function discover () {
  const q = h('input', { placeholder: 'Topic, e.g. chess', 'data-keep': 'topic', 'aria-label': 'Topic', value: ui.found?.name || '' })
  const search = attempt(async () => {
    const t = await me.topic(q.value)
    ui.found = { name: t.name, peers: (await t.search()).map(f => f.address) }
  })
  const f = ui.found, joined = f && app.topics.includes(f.name)
  return h('section', {},
    h('form', { class: 'row', onsubmit: e => { e.preventDefault(); search() } }, q, h('button', { class: 'btn primary' }, 'Search')),
    f && h('div', {},
      h('div', { class: 'row' }, h('h2', { style: 'flex:1;margin:0' }, `#${f.name}`),
        h('button', { class: 'btn', onclick: attempt(async () => {
          if (joined) { app.topics = app.topics.filter(x => x !== f.name); save(); await leave(f.name); return toast(`Left #${f.name}`) }
          app.topics.push(f.name); save(); await join(f.name); toast(`Joined #${f.name}`)
        }) }, joined ? 'Leave' : 'Join')),
      f.peers.length
        ? h('ul', { class: 'list' }, f.peers.map(a => h('li', { role: 'button', tabindex: 0, onclick: () => { addContact(a); ui.peer = a; ui.tab = 'peers'; render() } }, dot('recent'), h('div', { class: 'main' }, h('div', {}, nameOf(a)), h('div', { class: 'sub' }, app.contacts[a] ? 'In your peers' : 'Tap to add')))))
        : h('p', { class: 'mute small' }, 'Nobody here right now. Join to be found by others.')),
    h('h2', {}, 'Your topics'),
    app.topics.length ? h('ul', { class: 'list' }, app.topics.map(n => h('li', { role: 'button', tabindex: 0, onclick: () => { q.value = n; search() } }, h('span', { class: 'mute' }, '#'), h('div', { class: 'main' }, n)))) : h('p', { class: 'mute small' }, 'Search a topic and join it to see who is there and share updates with them.'))
}

function updates () {
  const text = h('input', { placeholder: 'Share a short update', 'data-keep': 'update', maxlength: 500, 'aria-label': 'Update' })
  const post = attempt(async () => {
    const body = { text: text.value.trim() }
    if (!body.text) return
    const targets = [ownTopic(me.address), ...app.topics]
    let sent = 0
    for (const n of targets) sent += (await (await me.topic(n)).broadcast(body).catch(() => ({ sent: 0 }))).sent
    feed.unshift({ from: me.address, topic: 'you', body, at: Date.now() })
    text.value = ''
    toast(sent ? `Shared with ${sent} connection${sent === 1 ? '' : 's'}` : 'Posted, but nobody is connected right now')
  })
  return h('section', {},
    h('form', { class: 'row', onsubmit: e => { e.preventDefault(); post() } }, text, h('button', { class: 'btn primary' }, 'Share')),
    feed.length
      ? h('ul', { class: 'list' }, feed.map(u => h('li', {}, h('div', { class: 'main' },
        h('div', { class: 'small mute' }, `${nameOf(u.from)} · ${u.topic.startsWith('@') ? 'update' : u.topic === 'you' ? 'you' : '#' + u.topic} · ${ago(u.at)}`),
        h('div', {}, typeof u.body === 'string' ? u.body : u.body?.text ?? JSON.stringify(u.body))))))
      : h('p', { class: 'empty' }, 'Updates from topics you joined and peers you follow appear here while you are online. They are live only: nothing is stored.'))
}

function messages () {
  const list = Object.keys(msgs).filter(a => msgs[a].length).sort((x, y) => msgs[y].at(-1).at - msgs[x].at(-1).at)
  return list.length
    ? h('ul', { class: 'list' }, list.map(a => h('li', { role: 'button', tabindex: 0, onclick: () => { ui.chat = a; render() } }, dot(presence(a)),
      h('div', { class: 'main' }, h('div', {}, nameOf(a)), h('div', { class: 'sub' }, `${msgs[a].at(-1).me ? 'You: ' : ''}${msgs[a].at(-1).text}`)), h('span', { class: 'small mute' }, ago(msgs[a].at(-1).at)))))
    : h('p', { class: 'empty' }, 'No conversations yet. Open a peer and press Message.')
}

function chat (a) {
  const text = h('input', { placeholder: 'Message', 'data-keep': `chat-${a}`, 'aria-label': 'Message' })
  const bubbles = h('div', { class: 'bubbles' }, (msgs[a] || []).map(m => h('div', { class: `bubble${m.me ? ' mine' : ''}`, title: new Date(m.at).toLocaleString() }, m.text)))
  setTimeout(() => { bubbles.scrollTop = bubbles.scrollHeight })
  const send = attempt(async () => {
    const t = text.value.trim()
    if (!t) return
    const ch = chans.get(a)
    if (ch?.readyState === 'open') ch.send(t); else await me.send(a, t)
    addMsg(a, { me: true, text: t })
    text.value = ''
  })
  return h('section', {},
    h('button', { class: 'back', onclick: () => { ui.chat = null; ui.tab = 'messages'; render() } }, '← Messages'),
    h('div', { class: 'me', role: 'button', onclick: () => { ui.peer = a; ui.chat = null; render() } }, dot(presence(a)), h('div', { class: 'main' }, h('b', {}, nameOf(a)), h('div', { class: 'small mute' }, LABEL[presence(a)]))),
    bubbles,
    h('form', { class: 'row', onsubmit: e => { e.preventDefault(); send() } }, text, h('button', { class: 'btn primary' }, 'Send')))
}

// ---- DOX --------------------------------------------------------------------------------------
function dox () {
  return h('article', {},
    h('h2', {}, 'What is CORVAX?'),
    h('p', {}, 'A peer-to-peer network for identities, connections, messages and small updates.'),
    h('p', {}, 'People find each other and connect directly, without a central platform.'),
    h('h2', {}, 'What can I do?'),
    h('ul', {}, ['Create your identity', 'Connect directly with peers', 'Send private messages', 'Discover people and topics', 'Follow updates', 'Share small updates', "See who's around"].map(t => h('li', {}, t))),
    h('h2', {}, 'How to use it'),
    h('ol', {}, ['Open APP and create your identity.', 'Share your invite link, or add a peer by address.', 'Connect and send messages.', 'Join topics, follow people and share updates.'].map(t => h('li', {}, t))),
    h('details', {}, h('summary', {}, 'Technical details'),
      h('p', { class: 'small' }, 'Identities are keys kept in your browser. Messages are end-to-end encrypted. Connections use WebRTC, directly or relayed by another peer. Presence means a peer renewed its lease lately, not that it is online. Updates are live only.'),
      h('h3', {}, 'This node'), h('pre', {}, node.line),
      h('h3', {}, 'Use it in code'),
      h('pre', {}, `import { Peer } from '${node.origin}/cx/index.js'\nconst me = await Peer.create()`),
      h('p', { class: 'small' }, 'Run a node: ', h('code', {}, 'npx corvax node'), ' · anchor list: ', h('code', {}, `curl -s ${node.origin}`), ' · ', h('a', { href: 'https://github.com/sloev/corvax' }, 'source')),
      h('h3', {}, 'Known anchors'), h('pre', {}, anchors.textContent),
      me && h('button', { class: 'back', style: 'color:var(--bad)', onclick: () => { if (confirm('Forget your identity, peers and messages in this browser?')) { store.clear(); location.reload() } } }, 'Forget my identity')))
}

// ---- STATS ------------------------------------------------------------------------------------
// The anchor's numbers come with the page (cached 30 s server-side); while visible they refresh every 30 s.
let anchorStats = JSON.parse(node.stats || '{}'), statsAt = Date.now()
setInterval(async () => {
  if (ui.view !== 'stats' || document.hidden) return
  const html = await fetch('/', { headers: { accept: 'text/html' } }).then(r => r.text(), () => '')
  const m = html.match(/data-stats="([^"]*)"/)
  if (m) { anchorStats = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')); statsAt = Date.now(); render() }
}, 30e3)
const rows = list => h('ul', { class: 'list' }, list.filter(([, v]) => v !== undefined).map(([k, v]) => h('li', {}, h('div', { class: 'main' }, k), h('b', {}, String(v)))))
function stats () {
  const s = anchorStats, up = +node.uptime + (Date.now() - started) / 1000
  return h('section', {},
    h('h2', {}, 'This anchor'),
    rows([['Peers listening', s.peers], ['Relay sessions', s.relays], ['Topics', s.topics], ['Live topic records', s.records],
      ['Queued messages', s.messages], ['DHT nodes', s.dht], ['Beacons', s.beacons], ['Services', (node.services || '').split(',').join(', ')], ['Up', since(up)]]),
    h('p', { class: 'small mute' }, `${ago(statsAt) === 'now' ? 'Updated just now' : `Updated ${ago(statsAt)} ago`} · refreshes every 30 s`),
    h('h2', {}, 'Your node'),
    me ? rows([['Open connections', [...chans.values()].filter(c => c.readyState === 'open').length], ['Topic links', me.topics.links.size],
      ['Topics joined', app.topics.length], ['Following', app.follows.length], ['Peers', Object.keys(app.contacts).length],
      ['Inbox anchors', me.inboxes.length], ['Known anchors', me.book.entries.size], ['Records in your store', me.store?.find([...me.topics.handles.values()].map(t => t.id)).length]])
      : h('p', { class: 'mute small' }, 'Go online in APP to see your own numbers.'))
}
const started = Date.now()
const since = s => s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} days`

// ---- boot ---------------------------------------------------------------------------------------
const invite = location.hash.match(/peer=([a-z0-9]{52})/)?.[1]
render()
if (app.live) online()
else if (invite) toast('Create an identity to add this peer')
